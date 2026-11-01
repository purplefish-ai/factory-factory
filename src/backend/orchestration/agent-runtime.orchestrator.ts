import {
  AgentSourcePollService,
  AgentEventEvaluationService,
  claimNextRun,
  maintainQueue,
  agentResolvedExecutionConfigSchema,
  type AgentClaimResult,
  type AgentExecutionConfig,
} from '@/backend/services/agent-definition';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { classifyGitHubCLIError, type githubCLIService } from '@/backend/services/github';
import { jobRunner } from '@/backend/services/job-runner.service';
import type { sessionProviderResolverService } from '@/backend/services/session';
import type { userSettingsService } from '@/backend/services/settings';

const JOB = 'agent-source-poll';
const EVALUATION_JOB = 'agent-event-evaluation';
type LaunchClaim = Extract<AgentClaimResult, { status: 'CLAIMED' }>;
type EvaluationWorker = {
  evaluatePendingEvents(signal: AbortSignal): Promise<void>;
  maintainQueue(): Promise<void>;
  claimNextRun(): Promise<AgentClaimResult>;
  consumeClaim?: (claim: LaunchClaim, signal: AbortSignal) => Promise<void>;
};
type AgentRuntimeServices = {
  userSettingsQueryService: Pick<typeof userSettingsService, 'get'>;
  sessionProviderResolverService: Pick<
    typeof sessionProviderResolverService,
    'resolveDefaultsForWorkspaceCreation'
  >;
  githubCLIService: Pick<
    typeof githubCLIService,
    'getAgentRepositoryIdentity' | 'listAgentIssueEvents'
  >;
  configService: { getAgentRuntimeLimits(): { githubPagesPerCycle: number } };
};

/** Composition owns provider wiring and intake lifecycle; the capsule owns persistence. */
export function createAgentRuntime(
  getServices: () => AgentRuntimeServices,
  consumeClaim?: EvaluationWorker['consumeClaim']
) {
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
  const evaluator = new AgentEventEvaluationService({
    resolveExecution: async (config) => resolveAgentExecutionConfig(getServices(), config),
  });
  return createAgentRuntimeLifecycle(poller, {
    evaluatePendingEvents: (signal) => evaluator.evaluatePendingEvents(signal),
    maintainQueue,
    claimNextRun,
    consumeClaim,
  });
}

export function createAgentRuntimeLifecycle(
  poller: Pick<AgentSourcePollService, 'pollCycle'>,
  worker?: EvaluationWorker
) {
  jobRunner.register({
    name: JOB,
    intervalMs: SERVICE_INTERVAL_MS.agentSourcePoll,
    runImmediately: true,
    run: (signal) => poller.pollCycle(signal),
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
        await worker.evaluatePendingEvents(signal);
        if (signal.aborted || !worker.consumeClaim) {
          return;
        }
        const claim = await worker.claimNextRun();
        // Once committed, the consumer owns settlement even if shutdown raced the claim.
        if (claim.status === 'CLAIMED') {
          await worker.consumeClaim(claim, signal);
        }
      },
    });
  }
  return {
    start: () => {
      jobRunner.start(JOB);
      if (worker) {
        jobRunner.start(EVALUATION_JOB);
      }
    },
    stop: async () => {
      await Promise.all([jobRunner.stop(JOB), ...(worker ? [jobRunner.stop(EVALUATION_JOB)] : [])]);
    },
  };
}

export async function resolveAgentExecutionConfig(
  services: Pick<
    AgentRuntimeServices,
    'userSettingsQueryService' | 'sessionProviderResolverService'
  >,
  config: AgentExecutionConfig
) {
  const { provider, model } =
    await services.sessionProviderResolverService.resolveDefaultsForWorkspaceCreation(
      config.provider,
      config.model
    );
  const settings = await services.userSettingsQueryService.get();
  const reasoningEffort =
    config.reasoningEffort ??
    (provider === 'CLAUDE'
      ? settings.defaultClaudeReasoningEffort
      : settings.defaultCodexReasoningEffort) ??
    undefined;
  return agentResolvedExecutionConfigSchema.parse({
    version: 1,
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });
}
