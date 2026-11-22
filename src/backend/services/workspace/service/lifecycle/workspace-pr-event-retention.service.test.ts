import { beforeEach, expect, it, vi } from 'vitest';

const { prune, pruneDeliveries, slim } = vi.hoisted(() => ({
  prune: vi.fn<(input: { before: Date; limit: number }) => Promise<number>>(),
  pruneDeliveries: vi.fn<
    (input: { before: Date; afterId: string; limit: number }) => Promise<{
      selected: number;
      lastId: string | null;
      deliveries: number;
      events: number;
    }>
  >(),
  slim: vi.fn<
    (input: { afterId: string; limit: number }) => Promise<{
      scanned: number;
      lastId: string | null;
      slimmed: number;
    }>
  >(),
}));
vi.mock('@/backend/services/workspace/resources/workspace-pr-event.accessor', () => ({
  workspacePrEventAccessor: {
    pruneTerminalEvents: prune,
    pruneSettledDeliveries: pruneDeliveries,
    slimReviewLists: slim,
  },
}));

import {
  PR_EVENT_RETENTION,
  PRReviewListSlimming,
  pruneSettledPRDeliveries,
  pruneTerminalPREvents,
  runPREventRetention,
} from './workspace-pr-event-retention.service';

const now = new Date('2026-11-03T12:00:00.000Z');
const before = new Date(now.getTime() - PR_EVENT_RETENTION.minAgeMs);

beforeEach(() => {
  prune.mockReset();
  pruneDeliveries.mockReset();
  slim.mockReset();
});

it('deletes full batches until a short batch shows the backlog is drained', async () => {
  prune.mockResolvedValueOnce(2).mockResolvedValueOnce(2).mockResolvedValueOnce(1);

  expect(await pruneTerminalPREvents({ now, batchSize: 2 })).toEqual({
    deleted: 5,
    batches: 3,
    complete: true,
  });
  expect(prune.mock.calls).toEqual([
    [{ before, limit: 2 }],
    [{ before, limit: 2 }],
    [{ before, limit: 2 }],
  ]);
});

it('stops at the per-run batch cap and leaves the rest for the next run', async () => {
  prune.mockResolvedValue(2);

  expect(await pruneTerminalPREvents({ now, batchSize: 2, maxBatches: 3 })).toEqual({
    deleted: 6,
    batches: 3,
    complete: false,
  });
  expect(prune).toHaveBeenCalledTimes(3);
});

it('does not start another batch after the job signal aborts', async () => {
  const controller = new AbortController();
  prune.mockImplementation(() => {
    controller.abort();
    return Promise.resolve(2);
  });

  expect(await pruneTerminalPREvents({ now, batchSize: 2, signal: controller.signal })).toEqual({
    deleted: 2,
    batches: 1,
    complete: false,
  });
  expect(prune).toHaveBeenCalledOnce();
});

it('uses the default retention window and batch size', async () => {
  prune.mockResolvedValue(0);

  expect(await pruneTerminalPREvents({ now })).toEqual({ deleted: 0, batches: 1, complete: true });
  expect(prune).toHaveBeenCalledExactlyOnceWith({
    before: new Date('2026-11-02T12:00:00.000Z'),
    limit: PR_EVENT_RETENTION.batchSize,
  });
});

const deliveryBatch = (selected: number, lastId: string | null, deliveries = selected) => ({
  selected,
  lastId,
  deliveries,
  events: deliveries * 2,
});

it('walks settled delivery candidates from the start until a short batch', async () => {
  pruneDeliveries
    .mockResolvedValueOnce(deliveryBatch(2, 'b', 1))
    .mockResolvedValueOnce(deliveryBatch(1, 'c'));

  expect(await pruneSettledPRDeliveries({ now, batchSize: 2 })).toEqual({
    deliveries: 2,
    events: 4,
    batches: 2,
    complete: true,
  });
  expect(pruneDeliveries.mock.calls).toEqual([
    [{ before, afterId: '', limit: 2 }],
    [{ before, afterId: 'b', limit: 2 }],
  ]);
});

it('caps and aborts the delivery pass like the terminal one', async () => {
  pruneDeliveries.mockResolvedValue(deliveryBatch(2, 'z'));
  expect(await pruneSettledPRDeliveries({ now, batchSize: 2, maxBatches: 3 })).toEqual({
    deliveries: 6,
    events: 12,
    batches: 3,
    complete: false,
  });

  const controller = new AbortController();
  pruneDeliveries.mockReset().mockImplementation(() => {
    controller.abort();
    return Promise.resolve(deliveryBatch(2, 'z'));
  });
  expect(
    await pruneSettledPRDeliveries({ now, batchSize: 2, signal: controller.signal })
  ).toMatchObject({ batches: 1, complete: false });
  expect(pruneDeliveries).toHaveBeenCalledExactlyOnceWith({ before, afterId: '', limit: 2 });
});

it('slims review lists in one pass that resumes across runs and then stops', async () => {
  const slimming = new PRReviewListSlimming();
  slim
    .mockResolvedValueOnce({ scanned: 2, lastId: 'b', slimmed: 2 })
    .mockResolvedValueOnce({ scanned: 2, lastId: 'd', slimmed: 1 })
    .mockResolvedValueOnce({ scanned: 1, lastId: 'e', slimmed: 0 });

  expect(await slimming.run({ batchSize: 2, maxBatches: 2 })).toEqual({
    slimmed: 3,
    batches: 2,
    complete: false,
  });
  expect(await slimming.run({ batchSize: 2, maxBatches: 2 })).toEqual({
    slimmed: 0,
    batches: 1,
    complete: true,
  });
  expect(slim.mock.calls).toEqual([
    [{ afterId: '', limit: 2 }],
    [{ afterId: 'b', limit: 2 }],
    [{ afterId: 'd', limit: 2 }],
  ]);

  // Once the pass reached the end, later runs read nothing.
  expect(await slimming.run({ batchSize: 2 })).toEqual({ slimmed: 0, batches: 0, complete: true });
  expect(slim).toHaveBeenCalledTimes(3);
});

it('does not start another slimming window after the job signal aborts', async () => {
  const controller = new AbortController();
  slim.mockImplementation(() => {
    controller.abort();
    return Promise.resolve({ scanned: 2, lastId: 'b', slimmed: 1 });
  });

  expect(await new PRReviewListSlimming().run({ batchSize: 2, signal: controller.signal })).toEqual(
    { slimmed: 1, batches: 1, complete: false }
  );
  expect(slim).toHaveBeenCalledOnce();
});

it('runs the three passes in turn with the job signal', async () => {
  prune.mockResolvedValue(1);
  pruneDeliveries.mockResolvedValue(deliveryBatch(0, null));
  slim.mockResolvedValue({ scanned: 0, lastId: null, slimmed: 0 });
  const signal = new AbortController().signal;
  const slimming = new PRReviewListSlimming();

  expect(await runPREventRetention({ now, signal, slimming })).toEqual({
    terminal: { deleted: 1, batches: 1, complete: true },
    deliveries: { deliveries: 0, events: 0, batches: 1, complete: true },
    reviewLists: { slimmed: 0, batches: 1, complete: true },
  });
  expect(prune).toHaveBeenCalledExactlyOnceWith({ before, limit: PR_EVENT_RETENTION.batchSize });
  expect(pruneDeliveries).toHaveBeenCalledExactlyOnceWith({
    before,
    afterId: '',
    limit: PR_EVENT_RETENTION.deliveryBatchSize,
  });
  expect(slim).toHaveBeenCalledExactlyOnceWith({
    afterId: '',
    limit: PR_EVENT_RETENTION.batchSize,
  });
});
