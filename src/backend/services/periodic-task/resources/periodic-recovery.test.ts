import { expect, it, vi } from 'vitest';
import type { PeriodicConfigRecovery } from '@/shared/schemas/periodic-recovery.schema';
import { periodicHistoryRecoverySchema } from '@/shared/schemas/periodic-recovery.schema';
import fixed from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import history from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import type { Prisma } from '@prisma-gen/client';
import { planPeriodicHistoryRecovery, restorePeriodicHistoryRecovery } from './periodic-recovery';
import { readPeriodicConfigRecoveryIds, restorePeriodicConfigRecovery } from './periodic-recovery';

it('reads all occupied identities once without input-sized SQL parameters before inserting or counting skips', async () => {
  const create = vi.fn().mockResolvedValue({});
  const findMany = vi.fn(() => {
    expect(create).not.toHaveBeenCalled();
    return Promise.resolve([{ id: 'existing' }]);
  });
  const tx = { periodicTask: { findMany, create } } as unknown as Prisma.TransactionClient;
  const row = fixed.data.recovery.periodicConfig.tasks[0]!;
  const section: PeriodicConfigRecovery = {
    version: 1,
    tasks: Array.from({ length: 1002 }, (_, i) => ({
      ...row,
      cadence: 'DAILY',
      id: i === 1001 ? 'existing' : String(i),
      projectId: i === 0 ? 'accepted' : 'skipped-parent',
    })),
  };
  const occupiedIds = await readPeriodicConfigRecoveryIds(tx);
  const { report, createdTaskIds } = await restorePeriodicConfigRecovery(
    tx,
    section,
    new Set(['accepted']),
    occupiedIds
  );
  expect(createdTaskIds).toEqual(new Set(['0']));
  expect(findMany).toHaveBeenCalledExactlyOnceWith({ select: { id: true } });
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith({
    data: {
      ...section.tasks[0],
      isEnabled: false,
      nextRunAt: new Date(row.nextRunAt),
      lastRunAt: new Date(row.lastRunAt),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    },
  });
  expect(report).toEqual({
    model: 'PeriodicTask',
    imported: 1,
    skipped: 1001,
    sourceEnabled: 1002,
    restoredDisabled: 1,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 1000 },
  });
});

it('propagates an owner create failure for the caller transaction to roll back', async () => {
  const failure = new Error('insert failed');
  const tx = {
    periodicTask: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockRejectedValue(failure),
    },
  } as unknown as Prisma.TransactionClient;
  await expect(
    restorePeriodicConfigRecovery(
      tx,
      {
        version: 1,
        tasks: [{ ...fixed.data.recovery.periodicConfig.tasks[0]!, cadence: 'DAILY' }],
      },
      new Set(['periodic-project']),
      new Set()
    )
  ).rejects.toBe(failure);
});

it('plans complete execution occupancy before writes and applies exclusive skip priority without borrowing parents', async () => {
  const create = vi.fn().mockResolvedValue({});
  const occupied = Array.from({ length: 1002 }, (_, i) => ({
    id: `local-${i}`,
    workspaceId: `slot-${i}`,
  }));
  const findMany = vi.fn(() => {
    expect(create).not.toHaveBeenCalled();
    return Promise.resolve(occupied);
  });
  const tx = { periodicTaskExecution: { findMany, create } } as unknown as Prisma.TransactionClient;
  const row = history.data.recovery.periodicHistory.executions[0]!;
  const section = periodicHistoryRecoverySchema.parse({
    version: 1,
    jsonStorage: [],
    executions: [
      { ...row, id: 'local-1001', workspaceId: 'slot-1000' },
      { ...row, id: 'conflict', workspaceId: 'slot-1001' },
      { ...row, id: 'missing' },
      { ...row, id: 'healthy', periodicTaskId: 'accepted' },
      { ...row, id: 'healthy-null', periodicTaskId: 'accepted' },
    ],
  });
  const plan = await planPeriodicHistoryRecovery(tx, section, new Set(['accepted']), new Set());
  const result = await restorePeriodicHistoryRecovery(tx, plan, new Set(['accepted']), new Set());
  expect(findMany).toHaveBeenCalledExactlyOnceWith({ select: { id: true, workspaceId: true } });
  expect(create).toHaveBeenCalledTimes(2);
  expect(result).toEqual({
    model: 'PeriodicTaskExecution',
    imported: 2,
    skipped: 3,
    sourceRunning: 5,
    restoredHistoricalFailed: 2,
    restoredSettled: 0,
    reasons: { EXISTING_IDENTITY: 1, CONFLICTING_IDENTITY_OR_PARENT: 1, INCOMPLETE_DEPENDENCY: 1 },
  });
  await expect(restorePeriodicHistoryRecovery(tx, plan, new Set(), new Set())).rejects.toThrow(
    'dependencies disagree'
  );
});
