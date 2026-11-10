import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { workspacePrEventAccessor } from '@/backend/services/workspace/resources/workspace-pr-event.accessor';

/**
 * Bounded retention for the PR fact ledger. Only unclaimed SUPERSEDED and
 * CANCELLED facts, and unclaimed PENDING facts of ARCHIVED workspaces, are
 * eligible; see `pruneTerminalEvents` for the predicate.
 */
export const PR_EVENT_RETENTION = Object.freeze({
  /** Terminal facts stay this long for short-term inspection. */
  minAgeMs: 24 * 60 * 60 * 1000,
  /** Rows per delete statement. Review payloads are often 30–80 KB each. */
  batchSize: 100,
  /** Caps one run; a larger backlog continues on the next run. */
  maxBatchesPerRun: 20,
});

export interface PrunePREventsResult {
  deleted: number;
  batches: number;
  /**
   * True when a short batch showed that no eligible row remains. False when the
   * run stopped at its batch cap or on abort before the backlog was drained.
   */
  complete: boolean;
}

/**
 * Prune old terminal PR facts in small batches. Each batch is its own short
 * write, and the loop yields between batches so other queries interleave with
 * the single better-sqlite3 connection.
 */
export async function pruneTerminalPREvents(
  input: {
    now?: Date;
    signal?: AbortSignal;
    batchSize?: number;
    maxBatches?: number;
  } = {}
): Promise<PrunePREventsResult> {
  const batchSize = input.batchSize ?? PR_EVENT_RETENTION.batchSize;
  const maxBatches = input.maxBatches ?? PR_EVENT_RETENTION.maxBatchesPerRun;
  const before = new Date((input.now ?? new Date()).getTime() - PR_EVENT_RETENTION.minAgeMs);
  let deleted = 0;
  for (let batches = 0; batches < maxBatches; batches++) {
    if (input.signal?.aborted) {
      return { deleted, batches, complete: false };
    }
    const count = await workspacePrEventAccessor.pruneTerminalEvents({ before, limit: batchSize });
    deleted += count;
    if (count < batchSize) {
      return { deleted, batches: batches + 1, complete: true };
    }
    await yieldToEventLoop();
  }
  return { deleted, batches: maxBatches, complete: false };
}
