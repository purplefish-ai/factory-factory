import { ARCHIVE_INCOMPLETE_PREFIX } from '@/backend/services/workspace/resources/workspace-archive-incomplete';

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
