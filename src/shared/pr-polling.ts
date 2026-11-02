// Closed PRs can reopen; merged PRs cannot. Use persisted observation time so
// both background schedulers share the same cadence, including after restart.
export const CLOSED_PR_POLL_INTERVAL_MS = 30 * 60_000;

export function shouldPollPR(
  pr: { state: string; observation: unknown; observationEpoch: number; syncedAt: Date | null },
  eventEpoch: number,
  now = Date.now()
): boolean {
  // Legacy snapshots and new recipient epochs need their own terminal facts.
  if (
    pr.observation === null ||
    pr.observation === undefined ||
    pr.observationEpoch !== eventEpoch
  ) {
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
