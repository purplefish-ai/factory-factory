import { beforeEach, expect, it, vi } from 'vitest';

const prune = vi.hoisted(() =>
  vi.fn<(input: { before: Date; limit: number }) => Promise<number>>()
);
vi.mock('@/backend/services/workspace/resources/workspace-pr-event.accessor', () => ({
  workspacePrEventAccessor: { pruneTerminalEvents: prune },
}));

import { PR_EVENT_RETENTION, pruneTerminalPREvents } from './workspace-pr-event-retention.service';

const now = new Date('2026-11-03T12:00:00.000Z');
const before = new Date(now.getTime() - PR_EVENT_RETENTION.minAgeMs);

beforeEach(() => {
  prune.mockReset();
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
