import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { workspacePrDeliveryAccessor } from '@/backend/services/workspace/resources/workspace-pr-delivery.accessor';
import { workspacePrEventAccessor } from '@/backend/services/workspace/resources/workspace-pr-event.accessor';

/**
 * Bounded retention for the PR fact ledger, in three passes per run:
 * unclaimed facts nobody can read (`pruneTerminalEvents`), settled delivery
 * units nobody reads (`pruneSettledDeliveries`), and the review lists that facts
 * written before #3288 still carry (`slimReviewLists`). See the event accessor
 * (first and last pass) and the delivery accessor (second pass) for each
 * predicate and docs/decisions/2026-11-13-pr-event-retention-without-vacuum.md
 * for why each is safe.
 */
export const PR_EVENT_RETENTION = Object.freeze({
  /** Terminal facts and settled deliveries stay this long for short-term inspection. */
  minAgeMs: 24 * 60 * 60 * 1000,
  /** Rows per delete statement. Review payloads are often 30–80 KB each. */
  batchSize: 100,
  /** Delivery units per delete transaction; each unit may hold several facts. */
  deliveryBatchSize: 25,
  /** Caps each pass of one run; a larger backlog continues on the next run. */
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

type PassInput = { now?: Date; signal?: AbortSignal; batchSize?: number; maxBatches?: number };

function retentionCutoff(now: Date | undefined) {
  return new Date((now ?? new Date()).getTime() - PR_EVENT_RETENTION.minAgeMs);
}

/**
 * Prune old terminal PR facts in small batches. Each batch is its own short
 * write, and the loop yields between batches so other queries interleave with
 * the single better-sqlite3 connection.
 */
export async function pruneTerminalPREvents(input: PassInput = {}): Promise<PrunePREventsResult> {
  const batchSize = input.batchSize ?? PR_EVENT_RETENTION.batchSize;
  const maxBatches = input.maxBatches ?? PR_EVENT_RETENTION.maxBatchesPerRun;
  const before = retentionCutoff(input.now);
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

export interface PruneSettledDeliveriesResult {
  /** Delivery units deleted, and the facts deleted with them. */
  deliveries: number;
  events: number;
  batches: number;
  /** True when the scan reached the last candidate; false at the cap or on abort. */
  complete: boolean;
}

/**
 * Prune settled delivery units nobody reads, each with all of its members in
 * one transaction. Each run walks the eligible units in ID order from the
 * start; the cursor carries it past any unit the deleting transaction declines.
 */
export async function pruneSettledPRDeliveries(
  input: PassInput = {}
): Promise<PruneSettledDeliveriesResult> {
  const limit = input.batchSize ?? PR_EVENT_RETENTION.deliveryBatchSize;
  const maxBatches = input.maxBatches ?? PR_EVENT_RETENTION.maxBatchesPerRun;
  const before = retentionCutoff(input.now);
  const result = { deliveries: 0, events: 0, batches: 0, complete: false };
  let afterId = '';
  while (result.batches < maxBatches && !input.signal?.aborted) {
    const batch = await workspacePrDeliveryAccessor.pruneSettledDeliveries({
      before,
      afterId,
      limit,
    });
    result.batches++;
    result.deliveries += batch.deliveries;
    result.events += batch.events;
    if (batch.selected < limit || !batch.lastId) {
      return { ...result, complete: true };
    }
    afterId = batch.lastId;
    await yieldToEventLoop();
  }
  return result;
}

export interface SlimReviewListsResult {
  slimmed: number;
  batches: number;
  /** True once a pass has reached the end of the ledger in this process. */
  complete: boolean;
}

/**
 * One pass over the ledger that removes the review lists facts written before
 * #3288 carry. Facts written since never carry one, so a pass that reaches the
 * end of the table is complete for the life of the process and later runs do
 * nothing. The cursor survives between runs, so a large ledger is scanned once,
 * a bounded window per batch, across as many runs as it needs. A backup restore
 * can bring old rows back, so it calls `restart`, and the next run scans again.
 */
export class PRReviewListSlimming {
  private afterId = '';
  private done = false;
  private generation = 0;

  /** Scan the whole ledger again from the start; a window in flight is discarded. */
  restart() {
    this.generation++;
    this.afterId = '';
    this.done = false;
  }

  async run(input: Omit<PassInput, 'now'> = {}): Promise<SlimReviewListsResult> {
    const limit = input.batchSize ?? PR_EVENT_RETENTION.batchSize;
    const maxBatches = input.maxBatches ?? PR_EVENT_RETENTION.maxBatchesPerRun;
    const result = { slimmed: 0, batches: 0, complete: this.done };
    while (!this.done && result.batches < maxBatches && !input.signal?.aborted) {
      const generation = this.generation;
      const batch = await workspacePrEventAccessor.slimReviewLists({
        afterId: this.afterId,
        limit,
      });
      result.batches++;
      result.slimmed += batch.slimmed;
      if (generation !== this.generation) {
        continue;
      }
      if (batch.scanned < limit || !batch.lastId) {
        this.done = true;
      } else {
        this.afterId = batch.lastId;
        await yieldToEventLoop();
      }
    }
    return { ...result, complete: this.done };
  }
}

const processSlimming = new PRReviewListSlimming();

/** Make this process's review-list pass scan the ledger again, after rows were imported. */
export function restartReviewListSlimming() {
  processSlimming.restart();
}

export interface PREventRetentionResult {
  terminal: PrunePREventsResult;
  deliveries: PruneSettledDeliveriesResult;
  reviewLists: SlimReviewListsResult;
}

/** One run of the `pr-event-retention` job: the three passes in turn, each bounded. */
export async function runPREventRetention(
  input: { now?: Date; signal?: AbortSignal; slimming?: PRReviewListSlimming } = {}
): Promise<PREventRetentionResult> {
  const pass = { now: input.now, signal: input.signal };
  const terminal = await pruneTerminalPREvents(pass);
  const deliveries = await pruneSettledPRDeliveries(pass);
  const reviewLists = await (input.slimming ?? processSlimming).run({ signal: input.signal });
  return { terminal, deliveries, reviewLists };
}
