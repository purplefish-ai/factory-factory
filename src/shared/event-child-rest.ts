import { z } from 'zod';
import { eventLaunchIdentifierSchema as id } from './event-agent-launch';

/**
 * Observed state of one child workspace of an event run's workspace.
 * ARCHIVED also covers archiving and deleted children (retained origin only).
 */
export const eventChildRestStateSchema = z.enum([
  'ARCHIVED',
  'SETUP_FAILED',
  'IDLE',
  'WAITING_ON_PERSON',
  'NOT_STARTED',
  'WORKING',
]);
export type EventChildRestState = z.infer<typeof eventChildRestStateSchema>;

const restingStates: ReadonlySet<EventChildRestState> = new Set([
  'ARCHIVED',
  'SETUP_FAILED',
  'IDLE',
  'WAITING_ON_PERSON',
]);
export function isChildAtRest(state: EventChildRestState) {
  return restingStates.has(state);
}

const childSchema = z.strictObject({ workspaceId: id, state: eventChildRestStateSchema });
export const eventChildRestSchema = z
  .strictObject({ atRest: z.boolean(), children: z.array(childSchema) })
  .refine(
    ({ atRest, children }) => atRest === children.every((child) => isChildAtRest(child.state)),
    'Inconsistent child rest'
  )
  .refine(
    ({ children }) => new Set(children.map((child) => child.workspaceId)).size === children.length,
    'Duplicate child workspace'
  );
export type EventChildRest = z.infer<typeof eventChildRestSchema>;

export function eventChildRest(children: z.input<typeof childSchema>[]): EventChildRest {
  return eventChildRestSchema.parse({
    atRest: children.every((child) => isChildAtRest(child.state)),
    children,
  });
}

/** Bounded settlement proof: state counts plus at most 20 children that were still held. */
export const eventChildRestProofSchema = z.strictObject({
  version: z.literal(1),
  observedAt: z.iso.datetime(),
  counts: z.strictObject({
    ARCHIVED: z.number().int().nonnegative(),
    SETUP_FAILED: z.number().int().nonnegative(),
    IDLE: z.number().int().nonnegative(),
    WAITING_ON_PERSON: z.number().int().nonnegative(),
    NOT_STARTED: z.number().int().nonnegative(),
    WORKING: z.number().int().nonnegative(),
  }),
  held: z.array(id).max(20),
});

export function eventChildRestProof(rest: EventChildRest, observedAt = new Date()) {
  const counts = Object.fromEntries(eventChildRestStateSchema.options.map((state) => [state, 0]));
  for (const child of rest.children) {
    counts[child.state] = (counts[child.state] ?? 0) + 1;
  }
  return eventChildRestProofSchema.parse({
    version: 1,
    observedAt: observedAt.toISOString(),
    counts,
    held: rest.children
      .filter((child) => !isChildAtRest(child.state))
      .map((child) => child.workspaceId)
      .slice(0, 20),
  });
}

/**
 * Status a run keeps when only children hold it and the deadline or ABANDON ends it.
 * A completed or failed initial turn keeps its outcome; anything else is null.
 */
export function childHeldOutcome(
  outcome: 'COMPLETED' | 'FAILED' | 'CANCELLED' | undefined,
  pullRequestCount: number
): 'COMPLETED' | 'PR_CREATED' | 'FAILED' | null {
  if (outcome === 'COMPLETED') {
    return pullRequestCount ? 'PR_CREATED' : 'COMPLETED';
  }
  return outcome === 'FAILED' ? 'FAILED' : null;
}
