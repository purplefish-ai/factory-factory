// Closed PRs can reopen; merged PRs cannot. Use persisted observation time so
// both background schedulers share the same cadence, including after restart.
export const CLOSED_PR_POLL_INTERVAL_MS = 30 * 60_000;

/** Whether a stored PR observation counts as present for the polling policy. */
export function hasPRObservation(observation: unknown): boolean {
  return observation !== null && observation !== undefined;
}

/**
 * The policy needs only whether an observation is stored, not its contents, so
 * polled reads can leave the observation blob out.
 */
export function shouldPollPR(
  pr: { state: string; hasObservation: boolean; observationEpoch: number; syncedAt: Date | null },
  eventEpoch: number,
  now = Date.now()
): boolean {
  // Legacy snapshots and new recipient epochs need their own terminal facts.
  if (!pr.hasObservation || pr.observationEpoch !== eventEpoch) {
    return true;
  }
  if (pr.state === 'MERGED') {
    return false;
  }
  return (
    pr.state !== 'CLOSED' ||
    pr.syncedAt === null ||
    now - pr.syncedAt.getTime() >= CLOSED_PR_POLL_INTERVAL_MS
  );
}
