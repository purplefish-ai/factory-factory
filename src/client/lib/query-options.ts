/**
 * Named query options. Call sites use these instead of numeric `refetchInterval`
 * or literal `retry` values; `factory/named-query-options` enforces it.
 *
 * Retries and window-focus refetching are set once in `createAppQueryClient`
 * (`./query-client.ts`); only override them here with a stated reason.
 */

/** Polling tiers, from fastest to slowest. Pick by what the user is waiting for. */
export const POLL_INTERVAL_MS = {
  /** An operation the user is watching finish: workspace setup output, a pending sign-in. */
  progress: 1000,
  /** A running dev server's status. */
  runningProcess: 2000,
  /** Screenshots arriving while a capture is in progress. */
  capture: 3000,
  /** Local machine and process state: system stats, an idle dev server, an update being applied. */
  localStatus: 5000,
  /** Lists and details that change as agents work: projects, sessions, agents, runs, logs. */
  activity: 10_000,
  /** Secondary workspace context: inbox, unread counts, workspace family, git changes. */
  workspaceContext: 15_000,
  /** Views that rarely change while open: the file tree, provider usage. */
  background: 30_000,
  /** Results from external services or provider discovery: issue trackers, the model catalog. */
  external: 60_000,
  /** Release checks while no update is in progress. */
  releaseCheck: 60 * 60_000,
} as const;

/**
 * Exceptions to the app's default retry policy (`shouldRetryQuery`). Each one
 * names why an automatic retry would be wrong for that query.
 */
export const QUERY_RETRY = {
  /**
   * Each attempt is costly (spawns `gh` or a provider process, or calls an
   * external service). Failures surface at once and the UI or the next poll
   * retries instead.
   */
  costlyRead: false,
  /**
   * The procedure reports permanent failures (a missing, unreadable or
   * oversized file) as server errors, so a retry only delays the fallback.
   */
  permanentServerError: false,
  /** A tight poll: the next tick, a second or two away, is the retry. */
  nextPoll: false,
} as const;
