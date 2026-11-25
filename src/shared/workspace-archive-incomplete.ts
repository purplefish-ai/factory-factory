/**
 * Marks a workspace whose archive reached worktree removal but did not finish.
 * Its worktree may be partly deleted, so it is never snapshotted again or set
 * up again; archiving again is the only way forward. The marker is the start
 * of the FAILED row's `initErrorMessage`, which every setup retry clears.
 */
export const ARCHIVE_INCOMPLETE_PREFIX = 'Archive incomplete:';

const MAX_REASON_LENGTH = 500;

/** The FAILED message that marks an archive whose worktree removal may have started. */
export function formatArchiveIncompleteMessage(reason: string): string {
  const trimmed = reason.trim().replace(/\.+$/, '');
  // Count code points so the cut never splits a surrogate pair.
  const codePoints = Array.from(trimmed);
  const bounded =
    codePoints.length > MAX_REASON_LENGTH
      ? `${codePoints.slice(0, MAX_REASON_LENGTH).join('')}…`
      : trimmed;
  return `${ARCHIVE_INCOMPLETE_PREFIX} ${bounded || 'worktree removal failed'}. Archive again to finish.`;
}

export function hasArchiveIncompleteMarker(initErrorMessage: string | null | undefined): boolean {
  return initErrorMessage?.startsWith(ARCHIVE_INCOMPLETE_PREFIX) === true;
}
