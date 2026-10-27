import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceAutoIterationService } from '@/backend/services/workspace/service/lifecycle/workspace-auto-iteration.service';
import type { AutoIterationProgress } from '@/shared/schemas/auto-iteration.schema';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const db = vi.hoisted(() => ({
  setAutoIterationStatus: vi.fn(),
  setAutoIterationProgress: vi.fn(),
  finishAutoIterationIfSessionMatches: vi.fn(),
  resetStaleAutoIterationStatuses: vi.fn(),
  findAutoIterationSnapshot: vi.fn(),
}));
vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: db,
}));

const snapshot = {
  mode: 'AUTO_ITERATION',
  autoIterationStatus: 'RUNNING',
  autoIterationConfig: { maxIterations: 12, instructions: 'x'.repeat(100_000) },
  autoIterationProgress: {
    currentIteration: 3,
    currentMetricSummary: 'score=7',
    lastTestOutput: 'x'.repeat(100_000),
  },
};
const progress = unsafeCoerce<AutoIterationProgress>(snapshot.autoIterationProgress);
const events: unknown[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  db.findAutoIterationSnapshot.mockResolvedValue(snapshot);
  db.setAutoIterationStatus.mockResolvedValue({ mode: 'AUTO_ITERATION', status: 'RUNNING' });
  workspaceAutoIterationService.on('auto_iteration_summary_changed', (event) => events.push(event));
});
afterEach(() => {
  events.length = 0;
  workspaceAutoIterationService.removeAllListeners();
});

it('publishes bounded persisted progress and config only after the write lands', async () => {
  let land!: () => void;
  db.setAutoIterationProgress.mockReturnValue(
    new Promise<void>((resolve) => {
      land = resolve;
    })
  );
  const write = workspaceAutoIterationService.setProgress('ws', progress);
  expect(events).toEqual([]);
  land();
  await write;
  expect(events).toEqual([
    {
      workspaceId: 'ws',
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'RUNNING',
      autoIteration: {
        status: 'RUNNING',
        currentIteration: 3,
        maxIterations: 12,
        currentMetricSummary: 'score=7',
      },
    },
  ]);
  expect(JSON.stringify(events).length).toBeLessThan(400);
});

it('publishes metric-only changes and explicit unknown clearing from persisted state', async () => {
  await workspaceAutoIterationService.setProgress('ws', progress);
  db.findAutoIterationSnapshot.mockResolvedValue({
    ...snapshot,
    autoIterationConfig: null,
    autoIterationProgress: { currentIteration: 3, currentMetricSummary: 'score=8' },
  });
  await workspaceAutoIterationService.setProgress('ws', progress);
  expect(events.at(-1)).toMatchObject({
    autoIteration: {
      status: 'RUNNING',
      currentIteration: 3,
      maxIterations: null,
      currentMetricSummary: 'score=8',
    },
  });
  db.findAutoIterationSnapshot.mockResolvedValue({
    ...snapshot,
    autoIterationStatus: null,
    autoIterationConfig: null,
    autoIterationProgress: null,
  });
  await workspaceAutoIterationService.setProgress('ws', progress);
  expect(events.at(-1)).toMatchObject({
    autoIteration: {
      status: null,
      currentIteration: null,
      maxIterations: null,
      currentMetricSummary: null,
    },
  });
});

it('announces neither rejected persistence nor a missed completion compare-and-swap', async () => {
  db.setAutoIterationProgress.mockRejectedValue(new Error('write rejected'));
  await expect(workspaceAutoIterationService.setProgress('ws', progress)).rejects.toThrow(
    'write rejected'
  );
  db.finishAutoIterationIfSessionMatches.mockResolvedValue({ settled: false, mode: null });
  await expect(
    workspaceAutoIterationService.finishSessionIfMatching('ws', 'old', 'FAILED')
  ).resolves.toBe(false);
  expect(events).toEqual([]);
});

it('drops an older accepted read when a newer accepted reset has published', async () => {
  let oldRead!: (value: typeof snapshot) => void;
  db.findAutoIterationSnapshot.mockReturnValueOnce(
    new Promise((resolve) => {
      oldRead = resolve;
    })
  );
  const oldWrite = workspaceAutoIterationService.setProgress('ws', progress);
  await Promise.resolve();
  db.findAutoIterationSnapshot.mockResolvedValue({
    ...snapshot,
    mode: 'STANDARD',
    autoIterationStatus: null,
    autoIterationConfig: null,
    autoIterationProgress: null,
  });
  await workspaceAutoIterationService.setStatus('ws', 'RUNNING');
  oldRead(snapshot);
  await oldWrite;
  expect(events).toEqual([
    { workspaceId: 'ws', mode: 'STANDARD', autoIterationStatus: null, autoIteration: null },
  ]);
});

it('publishes terminal completion and only the rows actually recovered after restart', async () => {
  db.finishAutoIterationIfSessionMatches.mockResolvedValue({
    settled: true,
    mode: 'AUTO_ITERATION',
  });
  db.findAutoIterationSnapshot.mockResolvedValue({ ...snapshot, autoIterationStatus: 'COMPLETED' });
  await workspaceAutoIterationService.finishSessionIfMatching('ws', 'active', 'COMPLETED');
  expect(events.at(-1)).toMatchObject({
    autoIteration: { status: 'COMPLETED', currentIteration: 3 },
  });
  events.length = 0;
  db.resetStaleAutoIterationStatuses.mockResolvedValue([{ id: 'stale' }]);
  db.findAutoIterationSnapshot.mockResolvedValue({ ...snapshot, autoIterationStatus: 'FAILED' });
  await workspaceAutoIterationService.recoverStaleStatuses();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ workspaceId: 'stale', autoIteration: { status: 'FAILED' } });
});

it('does not undo an accepted write when its publication read fails or the row disappears', async () => {
  db.findAutoIterationSnapshot.mockRejectedValueOnce(new Error('read unavailable'));
  await expect(workspaceAutoIterationService.setProgress('ws', progress)).resolves.toBeUndefined();
  db.findAutoIterationSnapshot.mockResolvedValueOnce(null);
  await workspaceAutoIterationService.setProgress('ws', progress);
  expect(events).toEqual([]);
});

it('does not invalidate the last accepted read when a newer write is rejected', async () => {
  let resolveRead!: (value: typeof snapshot) => void;
  db.findAutoIterationSnapshot.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRead = resolve;
    })
  );
  const accepted = workspaceAutoIterationService.setProgress('ws', progress);
  await Promise.resolve();
  db.setAutoIterationProgress.mockRejectedValueOnce(new Error('write rejected'));
  await expect(workspaceAutoIterationService.setProgress('ws', progress)).rejects.toThrow(
    'write rejected'
  );
  resolveRead(snapshot);
  await accepted;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ autoIteration: { currentIteration: 3 } });
});
