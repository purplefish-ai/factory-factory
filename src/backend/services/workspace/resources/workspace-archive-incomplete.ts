import type { Prisma } from '@prisma-gen/client';

/**
 * Marks a workspace whose archive reached worktree removal but did not finish.
 * Its worktree may be partly deleted, so it is never snapshotted again or
 * retried through setup; archiving again is the only way forward. The marker
 * lives in `initErrorMessage`, which every setup retry clears. The predicate
 * and message format are in `service/state/archive-incomplete.ts`.
 */
export const ARCHIVE_INCOMPLETE_PREFIX = 'Archive incomplete:';

export const withoutArchiveIncompleteMarker: Prisma.WorkspaceWhereInput = {
  OR: [
    { initErrorMessage: null },
    { NOT: { initErrorMessage: { startsWith: ARCHIVE_INCOMPLETE_PREFIX } } },
  ],
};

/**
 * A FAILED row that a setup retry may restart: under the retry budget and
 * without the marker, so an archive that marks it first wins the race.
 */
export function retryableFailedWorkspace(
  id: string,
  maxRetries: number
): Prisma.WorkspaceWhereInput {
  return {
    id,
    status: 'FAILED',
    initRetryCount: { lt: maxRetries },
    ...withoutArchiveIncompleteMarker,
  };
}
