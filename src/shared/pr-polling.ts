// Closed PRs can reopen; merged PRs cannot. Use persisted observation time so
// both background schedulers share the same cadence, including after restart.
export const CLOSED_PR_POLL_INTERVAL_MS = 30 * 60_000;

export function shouldPollPR(
  pr: { state: string; observation: unknown; syncedAt: Date | null },
  now = Date.now()
): boolean {
  // Legacy cached states need one normalized observation to commit transitions.
  if (pr.observation === null || pr.observation === undefined) {
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
