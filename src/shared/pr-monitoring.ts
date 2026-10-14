export { prDeliveryModeSchema } from './schemas/pr-event.schema';
export const PRDeliveryMode = { MAIN: 'MAIN', DEDICATED: 'DEDICATED' } as const;
export type PRDeliveryMode = (typeof PRDeliveryMode)[keyof typeof PRDeliveryMode];
export const PR_DEDICATED_WORKFLOW = 'pr-monitoring';

import type { PRFactPayload, PRMonitoringEventPayload } from './schemas/pr-event.schema';

export type {
  PRDeliveryRequest,
  PRFactPayload,
  PRMonitoringControlPayload,
  PRMonitoringEventPayload,
  PRObservation,
  PRTarget,
} from './schemas/pr-event.schema';
export interface PREventDraft {
  kind: PRMonitoringEventPayload['kind'];
  deduplicationKey: string;
  payload: PRMonitoringEventPayload;
}
export interface PRFactDraft extends PREventDraft {
  kind: PRFactPayload['kind'];
  payload: PRFactPayload;
}
export interface ClaimedPRDelivery {
  deliveryId: string;
  sessionId: string;
  deliveryProvider?: string | null;
  deliveryProviderSessionId?: string | null;
  bindingRevision: number;
  eventIds: string[];
  text: string;
  attempt: number;
}
export interface PRMonitoringProjection {
  deliveryMode: PRDeliveryMode;
  enabled: boolean;
  recipientSessionId: string | null;
  bindingRevision: number;
  pauseReason: string | null;
  pendingEventCount: number;
}
const resumablePauseReasons = new Set([
  'USER_STOPPED',
  'SESSION_FAILED',
  'RESUME_FAILED',
  'DELIVERY_FAILED',
  'RECEIPT_UNAVAILABLE',
]);
export function canResumePRMonitoring(reason: string | null | undefined): boolean {
  return reason != null && resumablePauseReasons.has(reason);
}
export const PR_EVENT_MESSAGE_ID_PREFIX = 'pr-event-';
export function prEventMarker(deliveryId: string): string {
  return `<!-- factory-factory-pr-event:${deliveryId} -->`;
}
export function isPRMonitoringRecipient(session: {
  workflow?: string | null;
  providerMetadata?: unknown;
}): boolean {
  return !['ratchet', 'auto-iteration', 'adversarial_review', PR_DEDICATED_WORKFLOW].includes(
    session.workflow ?? ''
  );
}

import type { PRObservation, PRTarget } from './schemas/pr-event.schema';
export interface PREventSummary {
  id: string;
  kind: PRFactPayload['kind'];
  payload: PRFactPayload;
  deduplicationKey?: string;
}
const failures = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ERROR',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);
export function prFailureSignature(observation: PRObservation): string {
  return JSON.stringify(
    observation.checks
      .filter((c) => failures.has(c.conclusion?.toUpperCase() ?? ''))
      .map((c) => [
        c.identity,
        c.attempt,
        c.name,
        c.workflowName,
        c.detailsUrl,
        c.startedAt,
        c.completedAt,
        c.conclusion,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}
export function reducePRObservation(input: {
  target: PRTarget;
  previous: PRObservation | null;
  current: PRObservation;
  transitionSequence: number;
  eventEpoch: number;
  pendingEvents: readonly PREventSummary[];
  deliveredEvents: readonly PREventSummary[];
  inFlightEvents?: readonly PREventSummary[];
  hashIdentity?: (identity: string) => string;
}) {
  const { target, previous, current, eventEpoch, pendingEvents, deliveredEvents } = input;
  const events: PRFactDraft[] = [];
  const supersededEventIds: string[] = [];
  let nextTransitionSequence = input.transitionSequence;
  const prefix = `${target.prId}:epoch:${eventEpoch}:`;
  const known = [...pendingEvents, ...deliveredEvents, ...(input.inFlightEvents ?? [])];
  const add = (payload: PRFactPayload, identity: string) => {
    const deduplicationKey = `${prefix}${input.hashIdentity ? input.hashIdentity(identity) : identity}`;
    if (!known.some((e) => e.deduplicationKey === deduplicationKey)) {
      events.push({ kind: payload.kind, deduplicationKey, payload });
    }
  };
  const terminal = current.prState === 'MERGED' || current.prState === 'CLOSED';
  supersededEventIds.push(
    ...pendingEvents
      .filter((event) => eventIsSuperseded(event, current, terminal))
      .map((event) => event.id)
  );
  if (terminal) {
    if (previous?.prState !== current.prState) {
      nextTransitionSequence++;
      add(
        {
          kind: current.prState === 'MERGED' ? 'PR_MERGED' : 'PR_CLOSED',
          target,
          observation: current,
        },
        `${current.prState}:${nextTransitionSequence}`
      );
    }
    return { events, supersededEventIds, nextTransitionSequence };
  }
  if (previous && ['MERGED', 'CLOSED'].includes(previous.prState)) {
    nextTransitionSequence++;
  }
  nextTransitionSequence = addCITransition(input, add, nextTransitionSequence);
  nextTransitionSequence = addConflictTransition(input, add, nextTransitionSequence);
  nextTransitionSequence = addReviewTransitions(input, add, nextTransitionSequence);
  return { events, supersededEventIds, nextTransitionSequence };
}

function eventIsSuperseded(
  event: PREventSummary,
  current: PRObservation,
  terminal: boolean
): boolean {
  const payload = event.payload;
  if (payload.observation.headSha !== current.headSha) {
    return true;
  }
  if (terminal && !['PR_MERGED', 'PR_CLOSED'].includes(event.kind)) {
    return true;
  }
  if (event.kind === 'CI_FAILED') {
    return (
      current.ciStatus === 'SUCCESS' ||
      (current.ciStatus === 'FAILURE' &&
        prFailureSignature(payload.observation) !== prFailureSignature(current))
    );
  }
  if (event.kind === 'CONFLICT_DETECTED') {
    return !current.hasMergeConflict;
  }
  return (
    payload.kind === 'REVIEW_FEEDBACK' &&
    payload.reviews.some(
      (r) =>
        current.resolvedReviewIds?.includes(r.identity) ||
        (current.reviewsComplete &&
          !current.actionableReviews.some(
            (c) => c.identity === r.identity && c.contentHash === r.contentHash
          ))
    )
  );
}
function addCITransition(
  input: Parameters<typeof reducePRObservation>[0],
  add: (payload: PRFactPayload, identity: string) => void,
  sequence: number
) {
  const { previous, current, target, deliveredEvents } = input;
  if (current.ciStatus === 'FAILURE') {
    const signature = prFailureSignature(current);
    if (
      !previous ||
      previous.headSha !== current.headSha ||
      previous.ciStatus !== 'FAILURE' ||
      prFailureSignature(previous) !== signature
    ) {
      sequence++;
      add(
        { kind: 'CI_FAILED', target, observation: current },
        `CI_FAILED:${current.headSha}:${sequence}:${signature}`
      );
    }
  } else if (current.ciStatus === 'SUCCESS') {
    const failure = deliveredEvents
      .filter((e) => e.kind === 'CI_FAILED' && e.payload.observation.headSha === current.headSha)
      .sort((a, b) => {
        return a.payload.observation.observedAt.localeCompare(b.payload.observation.observedAt);
      })
      .at(-1);
    if (!failure) {
      return sequence;
    }
    const identity = `CI_RECOVERED:${current.headSha}:${failure.deduplicationKey ?? failure.id}`;
    const key = `${target.prId}:epoch:${input.eventEpoch}:${input.hashIdentity ? input.hashIdentity(identity) : identity}`;
    if ([...input.pendingEvents, ...deliveredEvents].some((e) => e.deduplicationKey === key)) {
      return sequence;
    }
    sequence++;
    add({ kind: 'CI_RECOVERED', target, observation: current }, identity);
  }
  return sequence;
}

function addReviewTransitions(
  input: Parameters<typeof reducePRObservation>[0],
  add: (payload: PRFactPayload, identity: string) => void,
  sequence: number
) {
  const { previous, current, target } = input;
  for (const review of current.actionableReviews) {
    if (
      !previous?.actionableReviews.some(
        (r) => r.identity === review.identity && r.contentHash === review.contentHash
      ) ||
      previous.headSha !== current.headSha
    ) {
      sequence++;
      add(
        { kind: 'REVIEW_FEEDBACK', target, observation: current, reviews: [review] },
        `REVIEW:${current.headSha}:${review.identity}:${review.contentHash}:${sequence}`
      );
    }
  }
  return sequence;
}

function addConflictTransition(
  input: Parameters<typeof reducePRObservation>[0],
  add: (payload: PRFactPayload, identity: string) => void,
  sequence: number
) {
  const { previous, current, target, deliveredEvents } = input;
  if (current.hasMergeConflict !== (previous?.hasMergeConflict ?? false)) {
    sequence++;
    if (
      current.hasMergeConflict ||
      [...deliveredEvents, ...(input.inFlightEvents ?? [])].some(
        (e) => e.kind === 'CONFLICT_DETECTED'
      )
    ) {
      add(
        {
          kind: current.hasMergeConflict ? 'CONFLICT_DETECTED' : 'CONFLICT_CLEARED',
          target,
          observation: current,
        },
        `CONFLICT:${current.hasMergeConflict}:${sequence}`
      );
    }
  }
  return sequence;
}
