import { ARCHIVE_INCOMPLETE_PREFIX } from '@/shared/workspace-archive-incomplete';
import type { Prisma } from '@prisma-gen/client';

/** Rows without the archive-incomplete marker (see `@/shared/workspace-archive-incomplete`). */

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
