import type { Prisma } from '@prisma-gen/client';

/**
 * Marks a workspace whose archive reached worktree removal but did not finish.
 * Its worktree may be partly deleted, so it is never snapshotted again or
 * retried through setup; archiving again is the only way forward. The marker
 * lives in `initErrorMessage`, which every setup retry clears.
 */
const ARCHIVE_INCOMPLETE_PREFIX = 'Archive incomplete:';
const MAX_REASON_LENGTH = 500;

export function formatArchiveIncompleteMessage(reason: string): string {
  const trimmed = reason.trim().replace(/\.+$/, '');
  const bounded =
    trimmed.length > MAX_REASON_LENGTH ? `${trimmed.slice(0, MAX_REASON_LENGTH)}…` : trimmed;
  return `${ARCHIVE_INCOMPLETE_PREFIX} ${bounded || 'worktree removal failed'}. Archive again to finish.`;
}

export function hasArchiveIncompleteMarker(initErrorMessage: string | null | undefined): boolean {
  return initErrorMessage?.startsWith(ARCHIVE_INCOMPLETE_PREFIX) === true;
}

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
