import { ApplicationError } from '@/backend/lib/application-error';
import {
  AgentActivationService,
  AgentSourcePollService,
  AgentLedgerRetentionService,
  AgentEventEvaluationService,
  claimNextRun,
  maintainQueue,
  agentResolvedExecutionConfigSchema,
  type AgentClaimResult,
  type AgentExecutionConfig,
  type slackConnectionService,
} from '@/backend/services/agent-definition';
import { applicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { classifyGitHubCLIError, type githubCLIService } from '@/backend/services/github';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import type { classifyAgentEvent } from '@/backend/services/session';
import { createEventClassifierPort } from './agent-event-classifier.orchestrator';
import {
  resolveNativeExecution,
  type AgentNativeValidationServices,
} from './agent-native-validation';
import { createEventRunConsumer } from './event-run-consumer.orchestrator';
import { createSlackIntake } from './slack-intake.orchestrator';

const logger = createLogger('agent-runtime');
const JOB = 'agent-source-poll';
const EVALUATION_JOB = 'agent-event-evaluation';
const LAUNCH_JOB = 'agent-launch-maintenance';
type LaunchLifetime = Pick<
  ReturnType<typeof createEventRunConsumer>,
  'maintain' | 'closeAdmission' | 'stop'
>;
type LaunchClaim = Extract<AgentClaimResult, { status: 'CLAIMED' }>;
type EvaluationWorker = {
  evaluatePendingEvents(signal: AbortSignal): Promise<void>;
  /** Forget the rotation cursor so the next pass starts from the first trigger. */
  restartRotation?: () => void;
  maintainQueue(): Promise<void>;
  pruneExpired?: (signal: AbortSignal) => Promise<unknown>;
  claimNextRun(): Promise<AgentClaimResult>;
  consumeClaim?: (claim: LaunchClaim, signal: AbortSignal) => Promise<void>;
  canClaim?: () => boolean;
};
type AgentRuntimeServices = AgentNativeValidationServices & {
  githubCLIService: Pick<
    typeof githubCLIService,
    'getAgentRepositoryIdentity' | 'listAgentIssueEvents'
  >;
  slackConnectionService: Pick<
    typeof slackConnectionService,
    'getAppCredentials' | 'resolveEventContext'
  >;
  configService: {
    getAgentRuntimeLimits(): { githubPagesPerCycle: number; slackIntakeEnabled: boolean };
  };
  classifyAgentEvent: typeof classifyAgentEvent;
};

/** Composition owns provider wiring and intake lifecycle; the capsule owns persistence. */
export function createAgentRuntime(
  getServices: () => AgentRuntimeServices,
  consumeClaim?: EvaluationWorker['consumeClaim']
) {
  const launcher = consumeClaim ? undefined : createEventRunConsumer();
  const poller = new AgentSourcePollService(
    {
      getRepositoryIdentity: (repository, signal) =>
        getServices().githubCLIService.getAgentRepositoryIdentity(repository, signal),
      listIssueEvents: (input, signal) =>
        getServices().githubCLIService.listAgentIssueEvents(input, signal),
      classifyError: classifyGitHubCLIError,
    },
    () => getServices().configService.getAgentRuntimeLimits().githubPagesPerCycle
  );
  const activation = new AgentActivationService(poller);
  const retention = new AgentLedgerRetentionService();
  const evaluator = new AgentEventEvaluationService({
    resolveExecution: async (config) => resolveAgentExecutionConfig(getServices(), config),
    classifyEvent: createEventClassifierPort((input, signal) =>
      getServices().classifyAgentEvent(input, signal)
    ),
    resolveSlackContext: (event, config, signal) =>
      getServices().slackConnectionService.resolveEventContext(event, config, signal),
  });
  const lifecycle = createAgentRuntimeLifecycle(
    poller,
    {
      evaluatePendingEvents: (signal) => evaluator.evaluatePendingEvents(signal),
      restartRotation: () => evaluator.restartRotation(),
      maintainQueue,
      pruneExpired: (signal) => retention.pruneExpired(signal),
      claimNextRun,
      consumeClaim: consumeClaim ?? launcher?.consumeClaim,
      canClaim: launcher?.canClaim,
    },
    launcher,
    activation
  );
  const slackIntake = createSlackIntake(getServices);
  return {
    ...lifecycle,
    activation,
    start: () => {
      lifecycle.start();
      slackIntake.start();
    },
    stop: async () => {
      await Promise.all([slackIntake.stop(), lifecycle.stop()]);
    },
    hasWork: () => launcher?.hasWork() ?? false,
    recovery: launcher
      ? {
          inspectRun: launcher.inspectRun,
          resolveAmbiguousRun: (input: Parameters<typeof launcher.resolveAmbiguousRun>[0]) =>
            applicationUpdateAdmission.run(() => launcher.resolveAmbiguousRun(input)),
        }
      : undefined,
  };
}

export function createAgentRuntimeLifecycle(
  poller: Pick<AgentSourcePollService, 'pollCycle'>,
  worker?: EvaluationWorker,
  launcher?: LaunchLifetime,
  activation?: Pick<AgentActivationService, 'completePending' | 'completeSlackPending'>
) {
  if (launcher) {
    jobRunner.register({
      name: LAUNCH_JOB,
      intervalMs: SERVICE_INTERVAL_MS.agentEventEvaluation,
      runImmediately: true,
      run: (signal) =>
        applicationUpdateAdmission.isClosed()
          ? Promise.resolve()
          : applicationUpdateAdmission.run(() => launcher.maintain(signal)),
    });
  }
  jobRunner.register({
    name: JOB,
    intervalMs: SERVICE_INTERVAL_MS.agentSourcePoll,
    runImmediately: true,
    run: async (signal) => {
      await poller.pollCycle(signal);
      // Baselines resolve as the poll commits intervals; activation follows each cycle.
      if (!signal.aborted) {
        await activation?.completePending(signal);
      }
    },
  });
  if (worker) {
    jobRunner.register({
      name: EVALUATION_JOB,
      intervalMs: SERVICE_INTERVAL_MS.agentEventEvaluation,
      runImmediately: true,
      run: async (signal) => {
        await worker.maintainQueue();
        if (signal.aborted) {
          return;
        }
        await pruneLedger(worker, signal);
        if (signal.aborted) {
          return;
        }
        await completeSlackActivations(worker, activation, signal);
        if (signal.aborted) {
          return;
        }
        await worker.evaluatePendingEvents(signal);
        if (
          signal.aborted ||
          applicationUpdateAdmission.isClosed() ||
          !worker.consumeClaim ||
          worker.canClaim?.() === false
        ) {
          return;
        }
        await applicationUpdateAdmission.run(async () => {
          const claim = await worker.claimNextRun();
          // Once committed, the consumer owns settlement even if shutdown raced the claim.
          if (claim.status === 'CLAIMED') {
            await worker.consumeClaim?.(claim, signal);
          }
        });
      },
    });
  }
  return {
    start: () => {
      if (launcher) {
        jobRunner.start(LAUNCH_JOB);
      }
      jobRunner.start(JOB);
      if (worker) {
        jobRunner.start(EVALUATION_JOB);
      }
    },
    stop: async () => {
      launcher?.closeAdmission();
      await Promise.all([jobRunner.stop(JOB), ...(worker ? [jobRunner.stop(EVALUATION_JOB)] : [])]);
      if (launcher) {
        // Maintenance retains lease renewal during owned setup drain; no further takeovers after close.
        await jobRunner.waitForCurrentRun(LAUNCH_JOB);
        try {
          await launcher.stop();
        } finally {
          await jobRunner.stop(LAUNCH_JOB);
        }
      }
    },
  };
}

/**
 * Admission-time execution: explicit selections are pinned by the definition,
 * inherited ones follow current defaults, and the same native normalization as
 * Enable applies, so a run never freezes an effort its model rejects. An absent
 * effort stays absent so the provider's own default applies.
 */
export async function resolveAgentExecutionConfig(
  services: AgentNativeValidationServices,
  config: AgentExecutionConfig
) {
  const result = await resolveNativeExecution(config, services);
  if (result.status !== 'VALIDATED') {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'The selected native model does not support this reasoning effort.'
    );
  }
  const { provider, requestedModel, reasoningEffort } = result.intent;
  // With no explicit or default effort the provider's own default applies at
  // launch; only a requested effort the model rejects is normalized.
  return agentResolvedExecutionConfigSchema.parse({
    version: 1,
    provider,
    model: requestedModel,
    ...(result.requestedEffort !== null && reasoningEffort ? { reasoningEffort } : {}),
  });
}

/**
 * Slack test messages are already in the ledger. Activating first, then restarting the
 * rotation, lets the same pass evaluate the messages held while a trigger was STARTING.
 */
async function completeSlackActivations(
  worker: EvaluationWorker,
  activation: Pick<AgentActivationService, 'completeSlackPending'> | undefined,
  signal: AbortSignal
) {
  if (await activation?.completeSlackPending(signal)) {
    worker.restartRotation?.();
  }
}

async function pruneLedger(worker: EvaluationWorker, signal: AbortSignal) {
  try {
    await worker.pruneExpired?.(signal);
  } catch {
    if (!signal.aborted) {
      logger.warn('Agent ledger retention failed; evaluation will continue.', {
        reason: 'RETENTION_FAILED',
      });
    }
  }
}
