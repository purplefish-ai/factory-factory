import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceArchivedBlobsAccessor } from '@/backend/services/workspace/resources/workspace-archived-blobs.accessor';

const logger = createLogger('archived-workspace-blob-retention');

/**
 * What an ARCHIVED workspace keeps of its large columns; see
 * `workspace-archived-blobs.accessor.ts` for the exact rewrite.
 */
export const ARCHIVED_WORKSPACE_BLOB_RETENTION = Object.freeze({
  /** Characters of a failed setup's log kept after archive, truncation marker included. */
  initOutputTailChars: 4096,
  /** Rows per update. A row's attachments can be over 1 MB, so batches stay small. */
  batchSize: 10,
  /** Caps one run; a larger backlog continues on the next run. */
  maxBatchesPerRun: 50,
});

export interface ReleaseArchivedBlobsResult {
  released: number;
  batches: number;
  /**
   * True when a short batch showed that no eligible row remains. False when the
   * run stopped at its batch cap or on abort before the backlog was drained.
   */
  complete: boolean;
}

class ArchivedWorkspaceBlobRetentionService {
  /**
   * Called once a workspace is durably ARCHIVED. Best effort: a failure is
   * logged and left for the background backlog job, never surfaced to the
   * archive, which has already committed.
   */
  async releaseAfterArchive(workspaceId: string): Promise<void> {
    try {
      await workspaceArchivedBlobsAccessor.releaseOne(
        workspaceId,
        ARCHIVED_WORKSPACE_BLOB_RETENTION.initOutputTailChars
      );
    } catch (error) {
      logger.warn('Failed to release archived workspace data; the backlog job will retry', {
        workspaceId,
        error: toError(error).message,
      });
    }
  }

  /**
   * Release ARCHIVED workspaces still carrying attachments or a full setup log,
   * in small batches. Each batch is its own short write, the loop yields between
   * batches so other queries interleave with the single SQLite connection, and
   * an id cursor keeps one run from rescanning rows it has already passed.
   */
  async releaseBacklog(
    input: { signal?: AbortSignal; batchSize?: number; maxBatches?: number } = {}
  ): Promise<ReleaseArchivedBlobsResult> {
    const batchSize = input.batchSize ?? ARCHIVED_WORKSPACE_BLOB_RETENTION.batchSize;
    const maxBatches = input.maxBatches ?? ARCHIVED_WORKSPACE_BLOB_RETENTION.maxBatchesPerRun;
    let released = 0;
    let afterId = '';
    for (let batches = 0; batches < maxBatches; batches++) {
      if (input.signal?.aborted) {
        return { released, batches, complete: false };
      }
      const batch = await workspaceArchivedBlobsAccessor.releaseBatch({
        afterId,
        limit: batchSize,
        tailChars: ARCHIVED_WORKSPACE_BLOB_RETENTION.initOutputTailChars,
      });
      released += batch.released;
      if (batch.selected < batchSize || batch.lastId === null) {
        return { released, batches: batches + 1, complete: true };
      }
      afterId = batch.lastId;
      await yieldToEventLoop();
    }
    return { released, batches: maxBatches, complete: false };
  }
}

export const archivedWorkspaceBlobRetentionService = new ArchivedWorkspaceBlobRetentionService();
