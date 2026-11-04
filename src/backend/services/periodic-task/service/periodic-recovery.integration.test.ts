import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { jobRunner } from '@/backend/services/job-runner.service';
import { periodicTaskService } from '@/backend/services/periodic-task';
import { periodicTaskAccessor } from '@/backend/services/periodic-task/resources/periodic-task.accessor';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import fixed from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import history from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import { Prisma } from '@prisma-gen/client';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
}, 30_000);
beforeEach(async () => {
  await db.prisma.periodicTaskExecution.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.periodicTask.deleteMany();
  await clearIntegrationDatabase(db.prisma);
});
afterEach(async () => {
  await periodicTaskService.stop();
  vi.useRealTimers();
});
afterAll(async () => destroyIntegrationDatabase(db));

it('cannot reserve a past-due configuration imported disabled through the public backup service', async () => {
  await dataBackupService.importData(exportDataSchema.parse(fixed));
  const task = await db.prisma.periodicTask.findUniqueOrThrow({
    where: { id: 'scheduled-maintenance' },
  });
  expect(task.isEnabled).toBe(false);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  expect(task.nextRunAt.getTime()).toBeLessThan(Date.now());
  expect(await periodicTaskAccessor.reserveExecutionAndMarkDispatched(task.id)).toBeNull();
  expect(await db.prisma.periodicTaskExecution.count()).toBe(0);
  expect(await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
});

it('keeps linked imports inert on actual polling/restart, preserves live local work and enables only a fresh future slot', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  await db.prisma.project.create({
    data: {
      id: 'local',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  const runningTask = await periodicTaskService.create({
    projectId: 'local',
    name: 'Running',
    prompt: 'Keep live',
    cadence: 'DAILY',
  });
  const reservation = await periodicTaskAccessor.reserveExecutionAndMarkDispatched(runningTask.id);
  expect(reservation).not.toBeNull();
  const localWorkspace = await db.prisma.workspace.create({
    data: { id: 'local', name: 'Live local', projectId: 'local', periodicTaskId: runningTask.id },
  });
  await periodicTaskAccessor.updateExecution(reservation!.id, { workspaceId: localWorkspace.id });
  const liveBefore = await db.prisma.periodicTaskExecution.findUniqueOrThrow({
    where: { id: reservation!.id },
  });
  const taskBefore = await periodicTaskService.get(runningTask.id);
  await dataBackupService.importData(exportDataSchema.parse(history));
  expect(await db.prisma.periodicTaskExecution.findMany({ where: { status: 'RUNNING' } })).toEqual([
    liveBefore,
  ]);
  const importedHistory = await db.prisma.periodicTaskExecution.findUniqueOrThrow({
    where: { id: 'literal-history-running' },
  });
  expect(importedHistory.status).toBe('FAILED');
  expect(await periodicTaskService.get(runningTask.id)).toEqual(taskBefore);
  const imported = await periodicTaskService.get('scheduled-maintenance');
  expect(imported).toMatchObject({ isEnabled: false });
  expect(
    await periodicTaskAccessor.reserveExecutionAndMarkDispatched('scheduled-maintenance')
  ).toBeNull();
  const dispatch = vi.fn(async (event: { periodicTaskId: string; projectId: string }) => {
    const workspace = await db.prisma.workspace.create({
      data: {
        name: 'Fresh work',
        projectId: event.projectId,
        periodicTaskId: event.periodicTaskId,
      },
    });
    return { workspaceId: workspace.id };
  });
  const status = vi.fn(async () => ({
    status: 'READY' as const,
    prUrl: null,
    prNumber: null,
    isAgentWorking: true,
    initCompletedAt: new Date(),
    sessionFailureMessage: null,
    hasLaunchedSession: true,
  }));
  periodicTaskService.configure({
    timerDispatch: { dispatchTimerEvent: dispatch },
    status: { getWorkspaceStatus: status },
  });
  const poll = async () => {
    periodicTaskService.start();
    await jobRunner.waitForCurrentRun('periodic-task-poll');
    await periodicTaskService.stop();
  };
  await poll();
  await poll();
  expect(dispatch).not.toHaveBeenCalled();
  expect(status).toHaveBeenCalledWith(localWorkspace.id);
  expect(await periodicTaskService.get('scheduled-maintenance')).toEqual(imported);
  expect(
    await db.prisma.periodicTaskExecution.findUniqueOrThrow({ where: { id: liveBefore.id } })
  ).toEqual(liveBefore);
  const control = await periodicTaskService.create({
    projectId: 'local',
    name: 'Control',
    prompt: 'New',
    cadence: 'EVERY_MINUTE',
  });
  await poll();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ periodicTaskId: control.id })
  );
  await periodicTaskService.toggleEnabled(control.id, false);
  const enabled = await periodicTaskService.toggleEnabled('scheduled-maintenance', true);
  expect(enabled.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  await poll();
  await poll();
  expect(dispatch).toHaveBeenCalledOnce();
  vi.setSystemTime(new Date(enabled.nextRunAt.getTime() + 1));
  await poll();
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ periodicTaskId: enabled.id })
  );
  const fresh = await db.prisma.periodicTaskExecution.findMany({
    where: { periodicTaskId: enabled.id, status: 'RUNNING' },
  });
  expect(fresh.every((row) => row.id !== importedHistory.id)).toBe(true);
  expect(
    await db.prisma.periodicTaskExecution.findUniqueOrThrow({ where: { id: importedHistory.id } })
  ).toEqual(importedHistory);
  expect(fresh).toEqual([
    expect.objectContaining({
      status: 'RUNNING',
      workspaceId: expect.any(String),
      launchSnapshot: expect.objectContaining({ dueAt: enabled.nextRunAt.toISOString() }),
    }),
  ]);
  await poll();
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(
    await db.prisma.periodicTaskExecution.count({ where: { periodicTaskId: enabled.id } })
  ).toBe(2);
  expect(
    await db.prisma.periodicTaskExecution.findUniqueOrThrow({ where: { id: liveBefore.id } })
  ).toEqual(liveBefore);
});

it('roundtrips a canonical reserved execution as inert history with exact source diagnostics and dates', async () => {
  await db.prisma.project.create({
    data: {
      id: 'history-project',
      name: 'History',
      slug: 'history',
      repoPath: '/history',
      worktreeBasePath: '/history/w',
    },
  });
  const task = await periodicTaskService.create({
    projectId: 'history-project',
    name: 'Original',
    prompt: 'Original prompt',
    cadence: 'DAILY',
  });
  const reservation = await periodicTaskAccessor.reserveExecutionAndMarkDispatched(task.id);
  expect(reservation).not.toBeNull();
  await periodicTaskAccessor.updateExecution(reservation!.id, { errorMessage: '' });
  const original = await db.prisma.periodicTaskExecution.findUniqueOrThrow({
    where: { id: reservation!.id },
  });
  await periodicTaskService.update(task.id, {
    prompt: 'Edited after reservation',
    scheduledTime: '23:59',
    timezone: 'Asia/Tokyo',
  });
  const physical = () =>
    db.prisma
      .$queryRaw`SELECT id, launchSnapshot IS NULL AS sqlNull, json_type(launchSnapshot) AS kind FROM PeriodicTaskExecution ORDER BY id`;
  const physicalBefore = await physical();
  expect(physicalBefore).toEqual([{ id: original.id, sqlNull: 0n, kind: 'object' }]);
  const file = await dataBackupService.exportData('history-test');
  if (file.meta.schemaVersion !== 8 || !('recovery' in file.data)) {
    throw new Error('Expected current backup');
  }
  expect(file.meta.recovery.profile).toBe('base-json-slack-connections-1');
  expect(file.data.recovery.periodicHistory?.executions).toEqual([
    { ...original, startedAt: original.startedAt.toISOString(), completedAt: null },
  ]);
  await db.prisma.periodicTaskExecution.deleteMany();
  await db.prisma.periodicTask.deleteMany();
  await db.prisma.project.deleteMany();
  const result = await dataBackupService.importData(exportDataSchema.parse(file));
  const restored = await db.prisma.periodicTaskExecution.findUniqueOrThrow({
    where: { id: original.id },
  });
  expect(restored).toEqual({
    ...original,
    status: 'FAILED',
    errorMessage:
      '\n\nRecovery import: original status RUNNING. Marked FAILED as historical only; provider outcome is unknown and this execution will not be resumed.',
  });
  expect(await physical()).toEqual(physicalBefore);
  expect(result.recovery.periodicHistory).toMatchObject({
    imported: 1,
    skipped: 0,
    sourceRunning: 1,
    restoredHistoricalFailed: 1,
    restoredSettled: 0,
  });
});

it('preserves every terminal scalar, SQL versus JSON null and exact RUNNING prefixes across public restore and repeat', async () => {
  await dataBackupService.importData(exportDataSchema.parse(history));
  await db.prisma.periodicTaskExecution.deleteMany();
  const taskId = history.data.recovery.periodicConfig.tasks[0]!.id;
  const statuses = [
    'COMPLETED',
    'FAILED',
    'SKIPPED',
    'RUNNING',
    'RUNNING',
    'RUNNING',
    'PR_CREATED',
  ] as const;
  const errors = [null, '', 'settled\nΩ', null, '', '原始\nerror', null];
  for (const [i, status] of statuses.entries()) {
    await db.prisma.periodicTaskExecution.create({
      data: {
        id: `history-${i}`,
        periodicTaskId: taskId,
        status,
        errorMessage: errors[i],
        prUrl: i % 2 ? '' : 'https://example.test/Ω',
        prNumber: i % 2 ? null : 0,
        startedAt: new Date('2025-01-02T03:04:05.006Z'),
        completedAt: i === 0 ? new Date('2025-01-02T03:04:05.007Z') : null,
        launchSnapshot: i === 1 ? Prisma.JsonNull : Prisma.DbNull,
      },
    });
  }
  const physical = () =>
    db.prisma
      .$queryRaw`SELECT id, "launchSnapshot" IS NULL AS sqlNull, json_type("launchSnapshot") AS kind FROM "PeriodicTaskExecution" ORDER BY id`;
  const sourcePhysical = await physical();
  const file = await dataBackupService.exportData('history');
  const sourceRows = await db.prisma.periodicTaskExecution.findMany({ orderBy: { id: 'asc' } });
  await db.prisma.periodicTaskExecution.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.periodicTask.deleteMany();
  await db.prisma.project.deleteMany();
  const result = await dataBackupService.importData(exportDataSchema.parse(file));
  expect(await physical()).toEqual(sourcePhysical);
  const restored = await db.prisma.periodicTaskExecution.findMany({ orderBy: { id: 'asc' } });
  const diagnostic =
    'Recovery import: original status RUNNING. Marked FAILED as historical only; provider outcome is unknown and this execution will not be resumed.';
  expect(restored).toEqual(
    sourceRows.map((row) =>
      row.status === 'RUNNING'
        ? {
            ...row,
            status: 'FAILED',
            errorMessage:
              row.errorMessage === null ? diagnostic : `${row.errorMessage}\n\n${diagnostic}`,
          }
        : row
    )
  );
  expect(result.recovery.periodicHistory).toMatchObject({
    imported: 7,
    skipped: 0,
    sourceRunning: 3,
    restoredHistoricalFailed: 3,
    restoredSettled: 4,
  });
  const reexport = await dataBackupService.exportData('history');
  if (!('recovery' in reexport.data && 'recovery' in file.data)) {
    throw new Error('Expected current backup');
  }
  expect(reexport.data.recovery.periodicHistory?.jsonStorage).toEqual(
    file.data.recovery.periodicHistory?.jsonStorage
  );
  const repeat = await dataBackupService.importData(exportDataSchema.parse(reexport));
  expect(repeat.recovery.periodicHistory).toMatchObject({
    imported: 0,
    skipped: 7,
    sourceRunning: 0,
    restoredHistoricalFailed: 0,
    restoredSettled: 0,
    reasons: { EXISTING_IDENTITY: 7 },
  });
  expect(await db.prisma.periodicTaskExecution.findMany({ orderBy: { id: 'asc' } })).toEqual(
    restored
  );
  await db.prisma.periodicTaskExecution.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.periodicTask.deleteMany();
  await db.prisma.project.deleteMany();
  const settledImport = await dataBackupService.importData(exportDataSchema.parse(reexport));
  expect(settledImport.recovery.periodicHistory).toMatchObject({
    imported: 7,
    sourceRunning: 0,
    restoredHistoricalFailed: 0,
    restoredSettled: 7,
  });
  expect(await db.prisma.periodicTaskExecution.findMany({ orderBy: { id: 'asc' } })).toEqual(
    restored
  );
});

it('rolls back all owners after a late settings failure that observes the actual inserted history', async () => {
  await dataBackupService.importData(exportDataSchema.parse(history));
  await db.prisma.userSettings.create({ data: {} });
  const file = await dataBackupService.exportData('rollback-history');
  await db.prisma.periodicTaskExecution.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.periodicTask.deleteMany();
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.$executeRawUnsafe(
    "CREATE TRIGGER fail_after_history BEFORE INSERT ON UserSettings WHEN EXISTS (SELECT 1 FROM PeriodicTaskExecution WHERE id = 'literal-history-running') BEGIN SELECT RAISE(ABORT, 'observed actual history insertion'); END"
  );
  try {
    await expect(dataBackupService.importData(file)).rejects.toThrow(/userSettings.create/);
    for (const count of [
      await db.prisma.project.count(),
      await db.prisma.periodicTask.count(),
      await db.prisma.workspace.count(),
      await db.prisma.periodicTaskExecution.count(),
      await db.prisma.agentSession.count(),
      await db.prisma.terminalSession.count(),
      await db.prisma.userSettings.count(),
    ]) {
      expect(count).toBe(0);
    }
  } finally {
    await db.prisma.$executeRawUnsafe('DROP TRIGGER fail_after_history');
  }
});

it('fails export visibly for unsupported opaque stored snapshots instead of inventing producer evidence', async () => {
  await dataBackupService.importData(exportDataSchema.parse(history));
  await db.prisma.periodicTaskExecution.update({
    where: { id: 'literal-history-running' },
    data: { launchSnapshot: { opaqueCompatibilityFixture: true } },
  });
  await expect(dataBackupService.exportData('unsupported')).rejects.toThrow();
});
