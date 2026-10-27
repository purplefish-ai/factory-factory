import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workspaceAutoIterationService } from '@/backend/services/workspace/service/lifecycle/workspace-auto-iteration.service';
import type { AutoIterationProgress } from '@/shared/schemas/auto-iteration.schema';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  updateManyAndReturn: vi.fn(),
}));
vi.mock('@/backend/db', () => ({ prisma: { workspaceAutoIteration: db } }));

const written = {
  mode: 'AUTO_ITERATION',
  status: 'RUNNING',
  config: { maxIterations: 12, instructions: 'x'.repeat(100_000) },
  progress: {
    currentIteration: 3,
    currentMetricSummary: 'score=7',
    lastTestOutput: 'x'.repeat(100_000),
  },
};
const inputProgress = unsafeCoerce<AutoIterationProgress>({ currentIteration: 99 });
const events: unknown[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  db.updateManyAndReturn.mockResolvedValue([written]);
  db.updateMany.mockResolvedValue({ count: 1 });
  workspaceAutoIterationService.on('auto_iteration_summary_changed', (event) => events.push(event));
});
afterEach(() => {
  events.length = 0;
  workspaceAutoIterationService.removeAllListeners();
});

it('publishes bounded atomic progress/config only after acceptance, not from caller intent', async () => {
  let land!: (rows: (typeof written)[]) => void;
  db.updateManyAndReturn.mockReturnValue(
    new Promise((resolve) => {
      land = resolve;
    })
  );
  const write = workspaceAutoIterationService.setProgress('ws', inputProgress);
  expect(events).toEqual([]);
  land([written]);
  await expect(write).resolves.toBeUndefined();
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

it('preserves landed metric-only changes and explicit unknown nulls', async () => {
  await workspaceAutoIterationService.setProgress('ws', inputProgress);
  db.updateManyAndReturn.mockResolvedValue([
    {
      ...written,
      config: null,
      progress: { currentIteration: 3, currentMetricSummary: 'score=8' },
    },
  ]);
  await workspaceAutoIterationService.setProgress('ws', inputProgress);
  expect(events.at(-1)).toMatchObject({
    autoIteration: {
      status: 'RUNNING',
      currentIteration: 3,
      maxIterations: null,
      currentMetricSummary: 'score=8',
    },
  });
  db.updateManyAndReturn.mockResolvedValue([
    { ...written, status: null, config: null, progress: null },
  ]);
  await workspaceAutoIterationService.setProgress('ws', inputProgress);
  expect(events.at(-1)).toMatchObject({
    autoIteration: {
      status: null,
      currentIteration: null,
      maxIterations: null,
      currentMetricSummary: null,
    },
  });
});

it('publishes nothing for rejected persistence, missing rows or a missed completion CAS', async () => {
  db.updateManyAndReturn.mockRejectedValueOnce(new Error('write rejected'));
  await expect(workspaceAutoIterationService.setProgress('ws', inputProgress)).rejects.toThrow(
    'write rejected'
  );
  db.updateManyAndReturn.mockResolvedValue([]);
  await expect(workspaceAutoIterationService.setStatus('gone', 'RUNNING')).rejects.toThrow(
    'not found'
  );
  await expect(
    workspaceAutoIterationService.finishSessionIfMatching('ws', 'old', 'FAILED')
  ).resolves.toBe(false);
  expect(events).toEqual([]);
});

it('publishes the row accepted by terminal CAS and retains legacy status emission', async () => {
  const legacy: unknown[] = [];
  workspaceAutoIterationService.on('auto_iteration_status_changed', (event) => legacy.push(event));
  db.updateManyAndReturn.mockResolvedValue([{ ...written, status: 'COMPLETED' }]);
  await expect(
    workspaceAutoIterationService.finishSessionIfMatching('ws', 'active', 'COMPLETED')
  ).resolves.toBe(true);
  expect(events.at(-1)).toMatchObject({
    autoIteration: { status: 'COMPLETED', currentIteration: 3 },
  });
  expect(legacy).toEqual([{ workspaceId: 'ws', mode: 'AUTO_ITERATION', status: 'COMPLETED' }]);
});

it('publishes accepted startup recovery facts when the existing batch completes and omits lost guards', async () => {
  db.findMany.mockResolvedValue([
    { workspaceId: 'fast', sessionId: 'dead' },
    { workspaceId: 'slow', sessionId: 'old' },
  ]);
  let finishSlow!: (rows: (typeof written)[]) => void;
  db.updateManyAndReturn.mockImplementation((args: { where: { workspaceId: string } }) =>
    args.where.workspaceId === 'fast'
      ? Promise.resolve([{ ...written, status: 'FAILED' }])
      : new Promise((resolve) => {
          finishSlow = resolve;
        })
  );
  const recovery = workspaceAutoIterationService.recoverStaleStatuses();
  await vi.waitFor(() => expect(db.updateManyAndReturn).toHaveBeenCalledTimes(2));
  expect(events).toEqual([]);
  finishSlow([]);
  await expect(recovery).resolves.toEqual([{ id: 'fast' }]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ workspaceId: 'fast', autoIteration: { status: 'FAILED' } });
});

it('keeps accepted progress before a later terminal state without post-write reads', async () => {
  let landProgress!: (rows: (typeof written)[]) => void;
  let landCompletion!: (rows: (typeof written)[]) => void;
  db.updateManyAndReturn.mockReturnValueOnce(
    new Promise((resolve) => {
      landProgress = resolve;
    })
  );
  db.updateManyAndReturn.mockReturnValueOnce(
    new Promise((resolve) => {
      landCompletion = resolve;
    })
  );
  const progress = workspaceAutoIterationService.setProgress('ws', inputProgress);
  const completion = workspaceAutoIterationService.finishSessionIfMatching(
    'ws',
    'active',
    'FAILED'
  );
  landProgress([written]);
  landCompletion([{ ...written, status: 'FAILED' }]);
  await Promise.all([progress, completion]);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ autoIterationStatus: 'RUNNING' });
  expect(events[1]).toMatchObject({ autoIterationStatus: 'FAILED' });
});

it('retains recovery batch rejection without publishing buffered partial results', async () => {
  db.findMany.mockResolvedValue([
    { workspaceId: 'written', sessionId: 'dead' },
    { workspaceId: 'failed', sessionId: 'old' },
  ]);
  db.updateManyAndReturn.mockResolvedValueOnce([{ ...written, status: 'FAILED' }]);
  db.updateManyAndReturn.mockRejectedValueOnce(new Error('recovery rejected'));
  await expect(workspaceAutoIterationService.recoverStaleStatuses()).rejects.toThrow(
    'recovery rejected'
  );
  expect(events).toEqual([]);
});
