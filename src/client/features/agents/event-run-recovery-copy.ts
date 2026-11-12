import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/client/lib/trpc';
import { childHeldOutcome } from '@/shared/event-child-rest';
import type { EventRun } from './types';

type Outputs = inferRouterOutputs<AppRouter>['automation'];
export type RecoveryInspection = Outputs['inspectRun'];
export type ChildHold = NonNullable<RecoveryInspection['childHold']>;
type ServerAction = 'RESOLVE' | 'ABANDON' | 'RETRY';
/** The server's actions, plus Abandon that accepts an unproven stop (ABANDON with the opt-in). */
export type RecoveryAction = ServerAction | 'ABANDON_UNPROVEN';
export type RecoveryOutcome = 'RESOLVED' | 'ABANDONED' | 'ABANDONED_UNPROVEN' | 'RETRIED';
type UnavailableReason = Extract<Outputs['recoveryTarget'], { status: 'UNAVAILABLE' }>['reason'];

export const ACTION_LABELS: Record<RecoveryAction, string> = {
  RESOLVE: 'Resolve',
  RETRY: 'Retry',
  ABANDON: 'Abandon',
  ABANDON_UNPROVEN: 'Abandon anyway',
};

export const ACTION_SUMMARIES: Record<RecoveryAction, string> = {
  RESOLVE: 'Stop the agent and keep the run open for a later decision.',
  RETRY: 'Send the first message again in the same workspace.',
  ABANDON: 'End the run and free its run slot.',
  ABANDON_UNPROVEN: 'End the run and free its run slot without confirming that its agent stopped.',
};

/**
 * Why the server would refuse an action, in words. Covers the inspection's
 * blocks and every BLOCKED reason an action can return.
 */
const BLOCK_PHRASES: Record<string, string> = {
  PREPARATION_CLEANUP_UNCERTAIN:
    "Workspace setup stopped and its cleanup couldn't be confirmed, so the app can't safely end or retry the run.",
  PREVIOUS_WORK_PROOF_UNAVAILABLE:
    "The app can't confirm that the previous attempt's work stopped.",
  SOURCE_UNAVAILABLE:
    "The app has no record of the agent process for this run, so it can't confirm that this run's agent has stopped.",
  WORK_PROOF_UNAVAILABLE:
    "The app can't confirm that this run's agent has stopped, for example after the app restarted or while the agent still has work in progress.",
  CHILD_WORK_UNPROVEN: 'Some of its child workspaces are still working or have not started.',
  RESOURCES_UNAVAILABLE: "The run's workspace, session or account is no longer available.",
  OWNER_CLOSED: 'The app is shutting down.',
  OTHER_OWNER: 'Another part of the app is handling this run right now.',
  OWNER_CHANGED: 'The app started handling this run in a different way while the action ran.',
  OWNER_UNAVAILABLE: "The app no longer manages this run's agent session.",
  PROOF_OR_OWNERSHIP_UNAVAILABLE:
    "The app couldn't confirm that this run's agent stopped, or that it still manages the agent.",
};

export function describeRecoveryBlock(reason: string) {
  return BLOCK_PHRASES[reason] ?? 'The app reported an unrecognized reason.';
}

/** The first message's delivery state, as inspection reports it. */
export const FIRST_MESSAGE: Record<RecoveryInspection['run']['deliveryState'], string> = {
  PENDING: 'Not sent.',
  SENDING: 'Being sent; it may have reached the agent.',
  ACCEPTED: 'Accepted by the agent.',
  FINISHED: 'Sent, and the agent finished its first turn.',
  AMBIGUOUS: 'It may have reached the agent; the app lost track of it while sending.',
};

export const UNAVAILABLE_TARGET: Record<UnavailableReason, string> = {
  NOT_FOUND: 'This run no longer exists.',
  NOT_RECOVERABLE: 'This run has already finished. There is nothing to recover.',
  INVALID_STORED_DATA: "This run's stored data is invalid, so it can't be recovered here.",
};

/**
 * Each action, available (`reason` null) or not with the reason in words, in
 * the order offered. Mirrors the server: a common block stops every action; a
 * child hold leaves only Abandon; missing resources stop only Retry.
 */
export function recoveryAvailability(inspection: RecoveryInspection) {
  const reason = (action: ServerAction): string | null => {
    if (inspection.blocked) {
      return describeRecoveryBlock(inspection.blocked);
    }
    if (inspection.childHold && action !== 'ABANDON') {
      return describeRecoveryBlock('CHILD_WORK_UNPROVEN');
    }
    if (action === 'RETRY' && inspection.retryBlocked) {
      return describeRecoveryBlock(inspection.retryBlocked);
    }
    return null;
  };
  return (['RESOLVE', 'RETRY', 'ABANDON'] as const).map((action) => ({
    action,
    reason: reason(action),
  }));
}

export const CHILD_STATE_LABELS: Record<ChildHold['children'][number]['state'], string> = {
  WORKING: 'Working',
  NOT_STARTED: 'Not started',
  // At-rest states never hold a run; listed so every state has words.
  ARCHIVED: 'Archived',
  SETUP_FAILED: 'Setup failed',
  IDLE: 'Idle',
  WAITING_ON_PERSON: 'Waiting on a person',
};

export function childHoldTitle(heldCount: number) {
  return heldCount === 1
    ? 'Waiting on 1 child workspace'
    : `Waiting on ${heldCount} child workspaces`;
}

const STATUS_WORDS = {
  COMPLETED: 'Completed',
  PR_CREATED: 'PR created',
  FAILED: 'Failed',
} as const;

/**
 * What Abandon without a proven stop records: the result of the run's own first
 * turn when one was recorded (as settlement does), otherwise Cancelled.
 */
export function unprovenAbandonOutcome(inspection: RecoveryInspection, run: EventRun) {
  const noResult =
    "It's recorded as Cancelled, because its first turn has no completed or failed result.";
  // The fresh inspection decides whether a first-turn result exists; only a finished
  // delivery has one. The history row, possibly older, only names it.
  if (inspection.run.deliveryState !== 'FINISHED') {
    return noResult;
  }
  if (!run.initialOutcome) {
    return 'This run will keep the result of its own first turn.';
  }
  const kept = childHeldOutcome(run.initialOutcome.result, run.result?.pullRequests.length ?? 0);
  return kept
    ? `This run will keep the result of its own first turn: it's recorded as ${STATUS_WORDS[kept]}.`
    : noResult;
}

/** What Abandon records, matching the server's rules for a run with and without a child hold. */
export function abandonOutcome(inspection: RecoveryInspection, run: EventRun) {
  if (!inspection.childHold) {
    return "It's recorded as Cancelled, or Failed if its first turn failed.";
  }
  if (!inspection.childHold.keepsOutcome) {
    return "It's recorded as Cancelled, with a note that child workspaces were still working.";
  }
  const kept = childHeldOutcome(run.initialOutcome?.result, run.result?.pullRequests.length ?? 0);
  const words = kept ? ` (${STATUS_WORDS[kept]})` : '';
  return `This run will keep its outcome: it's recorded with the result of its own first turn${words} instead of Cancelled, with a note that child workspaces were still working.`;
}

export const OUTCOME_MESSAGES: Record<RecoveryOutcome, { title: string; body: string }> = {
  RESOLVED: {
    title: 'Run resolved.',
    body: 'Its agent is stopped. The run keeps its run slot until you retry or abandon it.',
  },
  ABANDONED: {
    title: 'Run abandoned.',
    body: 'Its run slot is free. Child workspaces were not stopped.',
  },
  ABANDONED_UNPROVEN: {
    title: 'Run abandoned.',
    body: "Its run slot is free. Factory Factory couldn't confirm its agent stopped: if it was still running, it keeps working in its workspace until you stop it there.",
  },
  RETRIED: {
    title: 'Retry started.',
    body: 'The first message is being sent again in the same workspace.',
  },
};
