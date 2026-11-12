import { TRPCError } from '@trpc/server';
import {
  agentRecoveryInputSchema,
  agentRecoveryInspectionSchema,
  agentRecoveryResultSchema,
  agentRecoveryTargetSchema,
} from '@/shared/event-agent-recovery';
import { eventRunFixture } from './event-history.story-fixtures';
import type { EventRun } from './types';

/**
 * Run recovery fixtures. Each copies what the backend returned for a real
 * launch, provider stop or child workspace in
 * `src/backend/trpc/agent-recovery.integration.test.ts` and
 * `src/backend/testing/event-run-child-recovery.integration.test.ts`, with only
 * IDs and times replaced, and is parsed with the shared schemas. Field
 * combinations the backend never writes stay out.
 */

const PROJECT_ID = 'owner';
const AGENT_ID = 'event-agent';
const WORKSPACE_ID = '2d7fdcd5-3c76-4db7-90ca-b91c19e53833';
const SESSION_ID = '032d697e-2eff-43f6-83a5-1298237ddddb';
const INITIAL_MESSAGE_ID = 'f1b0bdee-95c4-4e68-a227-704b3ef77f96';
const SEND_ATTEMPT_ID = '6c4509fe-56eb-4771-a236-cd32aa818cf9';

export type RecoveryFixture =
  | 'heldAfterTurn'
  | 'resolved'
  | 'childHeld'
  | 'deliveryUncertain'
  | 'setupUncertain';

const SETUP = { version: 1, state: 'STARTUP', setupStartedAt: '2026-11-11T09:00:06.000Z' } as const;
const FINISHED_DELIVERY = {
  state: 'FINISHED',
  sendingAt: '2026-11-11T09:01:00.000Z',
  acceptedAt: null,
  finishedAt: '2026-11-11T09:20:00.000Z',
} as const;
const COMPLETED_TURN = { result: 'COMPLETED', stopReason: 'end_turn' } as const;

/** The history row of each recovery state, as `automation.runs` returned it. */
const RUNS: Record<RecoveryFixture, Partial<EventRun>> = {
  // The first turn ended (`end_turn`); the run stays open until its own work is proven stopped.
  heldAfterTurn: {
    launchPhase: 'ACTIVE',
    reasonCode: null,
    delivery: FINISHED_DELIVERY,
    initialOutcome: COMPLETED_TURN,
  },
  // After RESOLVE: still RUNNING, holding its slot for a later decision.
  resolved: {
    launchPhase: 'NEEDS_ATTENTION',
    reasonCode: 'EXPLICITLY_RESOLVED',
    delivery: FINISHED_DELIVERY,
    initialOutcome: COMPLETED_TURN,
  },
  // The first turn ended while child workspaces were not at rest.
  childHeld: {
    launchPhase: 'ACTIVE',
    reasonCode: null,
    delivery: FINISHED_DELIVERY,
    initialOutcome: COMPLETED_TURN,
  },
  // The provider transport disconnected while the first message was being sent.
  deliveryUncertain: {
    launchPhase: 'NEEDS_ATTENTION',
    reasonCode: 'DELIVERY_UNCERTAIN',
    delivery: {
      state: 'AMBIGUOUS',
      sendingAt: '2026-11-11T09:01:00.000Z',
      acceptedAt: null,
      finishedAt: null,
    },
    initialOutcome: null,
  },
  // Setup stopped and its cleanup could not be confirmed (dispose with UNKNOWN cleanup).
  setupUncertain: {
    launchPhase: 'NEEDS_ATTENTION',
    reasonCode: 'PREPARATION_CLEANUP_UNCERTAIN',
    preparation: { ...SETUP, state: 'UNKNOWN' },
    delivery: { state: 'PENDING', sendingAt: null, acceptedAt: null, finishedAt: null },
    initialOutcome: null,
  },
};

/** A run in a recovery state, as the Runs view lists it. */
export function recoveryRunFixture(recovery: RecoveryFixture): EventRun {
  return eventRunFixture({
    id: `run-${recovery}`,
    eventId: `event-${recovery}`,
    createdAt: '2026-11-11T09:00:00.000Z',
    startedAt: '2026-11-11T09:00:04.000Z',
    completedAt: null,
    status: 'RUNNING',
    expiresAt: '2026-11-12T09:00:00.000Z',
    setupDeadlineAt: '2026-11-11T09:15:06.000Z',
    preparation: SETUP,
    result: null,
    reservedWorkspaceId: WORKSPACE_ID,
    reservedSessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    workspaceState: 'LIVE',
    ...RUNS[recovery],
  });
}

/**
 * The ambiguous-delivery run after Abandon with an accepted unproven stop: the
 * history keeps its AMBIGUOUS first message; only status and reason change.
 */
export function unprovenAbandonedRunFixture(): EventRun {
  return eventRunFixture({
    ...recoveryRunFixture('deliveryUncertain'),
    status: 'CANCELLED',
    launchPhase: 'FINISHED',
    reasonCode: 'ABANDONED_UNPROVEN',
    completedAt: '2026-11-11T10:00:00.000Z',
  });
}

/** The exact claim and current send for a run; a retry raises `attemptGeneration` to 2. */
export function recoveryContextFixture(runId: string, attemptGeneration = 1) {
  const rotated = attemptGeneration > 1;
  return {
    projectId: PROJECT_ID,
    claim: {
      status: 'CLAIMED' as const,
      runId,
      workerGeneration: 1,
      attemptGeneration,
      reservedWorkspaceId: WORKSPACE_ID,
      reservedSessionId: SESSION_ID,
      initialMessageId: INITIAL_MESSAGE_ID,
    },
    attempt: {
      runId,
      sessionId: SESSION_ID,
      // A retry rotates only the current send identities; the original message ID stays.
      messageId: rotated ? '7e76eb6f-d6ef-44fd-b0e1-b1b2c7660323' : INITIAL_MESSAGE_ID,
      sendAttemptId: rotated ? '53d21a81-5b19-4055-8a62-b3bfd9a8d68b' : SEND_ATTEMPT_ID,
      workerGeneration: 1,
      attemptGeneration,
    },
  };
}

function targetRun(run: EventRun) {
  return {
    status: 'RUNNING' as const,
    launchPhase: run.launchPhase,
    // The history row and the target read the same delivery record.
    deliveryState: run.delivery?.state,
    preparationState: run.preparation?.state ?? null,
  };
}

/** `automation.recoveryTarget` for a running run. */
export function recoveryTargetFixture(recovery: RecoveryFixture, attemptGeneration = 1) {
  const run = recoveryRunFixture(recovery);
  return agentRecoveryTargetSchema.parse({
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    runId: run.id,
    status: 'AVAILABLE',
    context: recoveryContextFixture(run.id, attemptGeneration),
    run: targetRun(run),
  });
}

/** `automation.recoveryTarget` once a run has finished, or for a run it can't find. */
export function unavailableTargetFixture(
  runId: string,
  reason: 'NOT_FOUND' | 'NOT_RECOVERABLE' | 'INVALID_STORED_DATA' = 'NOT_RECOVERABLE'
) {
  return agentRecoveryTargetSchema.parse({
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    runId,
    status: 'UNAVAILABLE',
    reason,
  });
}

const CHILD_HOLD = {
  children: [
    { workspaceId: 'cmwdynefv000qq6y4rj4h4ooe', state: 'WORKING' },
    { workspaceId: 'cmwdynefv000rq6y4child002', state: 'NOT_STARTED' },
  ],
  heldCount: 2,
  // 24 hours after the run's own first turn ended.
  deadlineAt: '2026-11-12T09:20:00.000Z',
  keepsOutcome: true,
} as const;

/** What `automation.inspectRun` returned for each state in the backend tests. */
const INSPECTIONS = {
  // Own work not yet proven stopped: each action stops it first.
  heldAfterTurn: {
    blocked: null,
    unprovenAbandonAvailable: false,
    childHold: null,
    proofAvailable: false,
  },
  resolved: {
    blocked: null,
    unprovenAbandonAvailable: false,
    childHold: null,
    proofAvailable: true,
  },
  childHeld: {
    blocked: null,
    unprovenAbandonAvailable: false,
    childHold: CHILD_HOLD,
    proofAvailable: false,
  },
  // Every common block leaves Abandon with an accepted unproven stop
  // (`event-run-unproven-abandon.integration.test.ts`).
  deliveryUncertain: {
    blocked: 'WORK_PROOF_UNAVAILABLE',
    unprovenAbandonAvailable: true,
    childHold: null,
    proofAvailable: false,
  },
  setupUncertain: {
    blocked: 'PREPARATION_CLEANUP_UNCERTAIN',
    unprovenAbandonAvailable: true,
    childHold: null,
    proofAvailable: false,
  },
} as const;

/** `automation.inspectRun` for a recovery state, echoing the target's context unchanged. */
export function recoveryInspectionFixture(
  recovery: RecoveryFixture,
  options: { retryUnavailable?: boolean; attemptGeneration?: number } = {}
) {
  const run = recoveryRunFixture(recovery);
  return agentRecoveryInspectionSchema.parse({
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    runId: run.id,
    context: recoveryContextFixture(run.id, options.attemptGeneration),
    run: targetRun(run),
    ...INSPECTIONS[recovery],
    retryBlocked: options.retryUnavailable ? 'RESOURCES_UNAVAILABLE' : null,
    retryResourcesAvailable: !options.retryUnavailable,
    delivery: run.delivery?.state === 'PENDING' ? 'UNSENT' : 'REACHED_OR_UNCERTAIN',
  });
}

/** `automation.resolveAmbiguousRun`. RETRIED carries the rotated claim and send. */
export function recoveryResultFixture(
  input: unknown,
  blocked?: 'CHILD_WORK_UNPROVEN' | 'PROOF_OR_OWNERSHIP_UNAVAILABLE' | 'RESOURCES_UNAVAILABLE'
) {
  const parsed = agentRecoveryInputSchema.parse(input);
  if (blocked) {
    return agentRecoveryResultSchema.parse({ status: 'BLOCKED', reason: blocked });
  }
  if (parsed.action === 'RETRY') {
    const next = recoveryContextFixture(parsed.claim.runId, parsed.claim.attemptGeneration + 1);
    return agentRecoveryResultSchema.parse({
      status: 'RETRIED',
      claim: next.claim,
      attempt: next.attempt,
    });
  }
  return agentRecoveryResultSchema.parse({
    status: parsed.action === 'RESOLVE' ? 'RESOLVED' : 'ABANDONED',
  });
}

/** The server's answer to a stale claim or send: HTTP 409 with this message. */
export function staleRecoveryContextError() {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'Event recovery context is unavailable or changed.',
  });
}
