import { agentEvaluationHistorySchema, agentRunHistorySchema } from '@/shared/agent-history';
import type { EventEvaluation, EventRun } from './types';

/** A finished run that opened a pull request; override fields for other states. */
export function eventRunFixture(overrides: Partial<EventRun> = {}): EventRun {
  return agentRunHistorySchema.parse({
    id: 'run-pr',
    context: { state: 'RETAINED' },
    agentId: 'event-agent',
    triggerId: 'saved-event:github',
    eventId: 'event-pr',
    createdAt: '2026-11-10T09:00:00.000Z',
    startedAt: '2026-11-10T09:00:05.000Z',
    completedAt: '2026-11-10T09:24:00.000Z',
    status: 'PR_CREATED',
    launchPhase: 'FINISHED',
    reasonCode: null,
    attemptCount: 1,
    attemptGeneration: 1,
    nextAttemptAt: null,
    expiresAt: null,
    setupDeadlineAt: null,
    turnDeadlineAt: null,
    preparation: null,
    delivery: null,
    initialOutcome: { result: 'COMPLETED', stopReason: 'end_turn' },
    result: {
      version: 1,
      summary: 'Fixed the flaky retry test.',
      pullRequests: [{ url: 'https://github.com/example/repo/pull/42', number: 42 }],
    },
    reservedWorkspaceId: 'workspace-pr',
    reservedSessionId: 'session-pr',
    workspaceId: 'workspace-pr',
    workspaceState: 'LIVE',
    ...overrides,
  });
}

/** One run in each state the Runs view distinguishes, newest first. */
export function eventRunPageFixture(): EventRun[] {
  return [
    eventRunFixture({
      id: 'run-queued',
      eventId: 'event-queued',
      createdAt: '2026-11-11T10:00:00.000Z',
      startedAt: null,
      completedAt: null,
      status: 'QUEUED',
      launchPhase: 'RESERVED',
      initialOutcome: null,
      result: null,
      expiresAt: '2026-11-12T10:00:00.000Z',
      reservedWorkspaceId: null,
      reservedSessionId: null,
      workspaceId: null,
      workspaceState: 'UNRESERVED',
    }),
    eventRunFixture({
      id: 'run-attention',
      eventId: 'event-attention',
      createdAt: '2026-11-11T09:00:00.000Z',
      startedAt: '2026-11-11T09:00:04.000Z',
      completedAt: null,
      status: 'RUNNING',
      launchPhase: 'NEEDS_ATTENTION',
      reasonCode: 'DELIVERY_UNCERTAIN',
      initialOutcome: null,
      result: null,
      delivery: {
        state: 'AMBIGUOUS',
        sendingAt: '2026-11-11T09:01:00.000Z',
        acceptedAt: null,
        finishedAt: null,
      },
      reservedWorkspaceId: 'workspace-attention',
      reservedSessionId: 'session-attention',
      workspaceId: 'workspace-attention',
      workspaceState: 'LIVE',
    }),
    eventRunFixture(),
    eventRunFixture({
      id: 'run-completed',
      eventId: 'event-completed',
      createdAt: '2026-11-09T15:00:00.000Z',
      startedAt: '2026-11-09T15:00:04.000Z',
      completedAt: '2026-11-09T15:12:00.000Z',
      status: 'COMPLETED',
      // No validated result metadata: shown as nothing, not as an empty result.
      result: null,
      reservedWorkspaceId: 'workspace-completed',
      reservedSessionId: 'session-completed',
      workspaceId: 'workspace-completed',
    }),
    eventRunFixture({
      id: 'run-overflow',
      eventId: 'event-overflow',
      createdAt: '2026-11-09T12:00:00.000Z',
      startedAt: null,
      completedAt: '2026-11-09T12:00:00.000Z',
      status: 'CANCELLED',
      reasonCode: 'QUEUE_OVERFLOW',
      initialOutcome: null,
      result: null,
      reservedWorkspaceId: null,
      reservedSessionId: null,
      workspaceId: null,
      workspaceState: 'UNRESERVED',
    }),
    eventRunFixture({
      id: 'run-setup-timeout',
      eventId: null,
      createdAt: '2026-11-08T12:00:00.000Z',
      startedAt: '2026-11-08T12:00:03.000Z',
      completedAt: '2026-11-08T12:30:00.000Z',
      status: 'FAILED',
      reasonCode: 'SETUP_TIMEOUT',
      initialOutcome: null,
      result: null,
      context: { version: 1, state: 'EXPIRED', expiredAt: '2026-11-10T00:00:00.000Z' },
      reservedWorkspaceId: 'workspace-deleted',
      reservedSessionId: 'session-deleted',
      workspaceId: null,
      workspaceState: 'DELETED',
    }),
  ];
}

export function eventEvaluationFixture(overrides: Partial<EventEvaluation> = {}): EventEvaluation {
  return agentEvaluationHistorySchema.parse({
    id: 'evaluation-matched',
    eventId: 'event-pr',
    triggerId: 'saved-event:github',
    runId: 'run-pr',
    createdAt: '2026-11-10T09:00:00.000Z',
    status: 'MATCHED',
    reasonCode: 'DETERMINISTIC_MATCH',
    // The history API returns this fixed text rather than the stored explanation.
    explanation: 'Recorded event evaluation.',
    definitionRevision: 1,
    triggerRevision: 1,
    activationGeneration: 1,
    attemptCount: 1,
    nextAttemptAt: null,
    expiresAt: '2026-12-10T09:00:00.000Z',
    ...overrides,
  });
}

/** An errored, a skipped and a matched evaluation, newest first. */
export function eventEvaluationPageFixture(): EventEvaluation[] {
  return [
    eventEvaluationFixture({
      id: 'evaluation-error',
      eventId: 'event-error',
      runId: null,
      createdAt: '2026-11-11T08:00:00.000Z',
      status: 'ERROR',
      reasonCode: 'EXECUTION_RESOLUTION_RETRY',
      attemptCount: 2,
      nextAttemptAt: '2026-11-11T08:05:00.000Z',
    }),
    eventEvaluationFixture({
      id: 'evaluation-skipped',
      eventId: 'event-skipped',
      runId: null,
      createdAt: '2026-11-10T10:00:00.000Z',
      status: 'SKIPPED',
      reasonCode: 'LABEL_MISMATCH',
    }),
    eventEvaluationFixture(),
  ];
}
