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
import links from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
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
  await dataBackupService.importData(exportDataSchema.parse(links));
  expect(await db.prisma.periodicTaskExecution.findMany()).toEqual([liveBefore]);
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
    where: { periodicTaskId: enabled.id },
  });
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
  ).toBe(1);
  expect(
    await db.prisma.periodicTaskExecution.findUniqueOrThrow({ where: { id: liveBefore.id } })
  ).toEqual(liveBefore);
});
