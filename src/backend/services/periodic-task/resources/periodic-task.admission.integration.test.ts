import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PeriodicTask } from '@prisma-gen/client';

let db: IntegrationDatabase;
let accessor: typeof import('./periodic-task.accessor').periodicTaskAccessor;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ periodicTaskAccessor: accessor } = await vi.importActual<
    typeof import('./periodic-task.accessor')
  >('./periodic-task.accessor'));
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
}, 30_000);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-03-10T12:00:00Z'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await db.prisma.periodicTask.deleteMany();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function createTask(data: Partial<PeriodicTask> = {}) {
  return db.prisma.periodicTask.create({
    data: {
      projectId: 'project',
      name: 'Original',
      prompt: 'Original instructions',
      cadence: 'DAILY',
      nextRunAt: new Date('2024-03-09T14:00:00Z'),
      scheduledTime: '09:00',
      timezone: 'America/New_York',
      ...data,
    },
  });
}
function reserve(task: PeriodicTask) {
  return accessor.reserveExecutionAndMarkDispatched(task.id);
}

it('advances the canonical calendar after a schedule edited since polling becomes due', async () => {
  const stale = await createTask();
  await accessor.update(stale.id, { cadence: 'MONTHLY', scheduledTime: '10:00', timezone: 'UTC' });
  const edited = await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: stale.id } });
  expect(edited.nextRunAt).toEqual(new Date('2024-04-10T10:00:00Z'));
  vi.setSystemTime(new Date('2024-04-10T10:01:00Z'));
  await reserve(stale);
  expect(await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject(
    {
      nextRunAt: new Date('2024-05-10T10:00:00Z'),
    }
  );
});

it('rejects an edited future schedule without consuming it', async () => {
  const stale = await createTask();
  await accessor.update(stale.id, { scheduledTime: '10:00' });
  const edited = await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: stale.id } });
  expect(await reserve(stale)).toBeNull();
  expect(await db.prisma.periodicTaskExecution.count()).toBe(0);
  expect(await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject(
    {
      nextRunAt: edited.nextRunAt,
      lastRunAt: null,
    }
  );
});

it('does not admit a due task while its previous run is still running', async () => {
  const task = await createTask();
  await db.prisma.periodicTaskExecution.create({
    data: { periodicTaskId: task.id, status: 'RUNNING' },
  });
  expect(await reserve(task)).toBeNull();
  expect(await db.prisma.periodicTaskExecution.count()).toBe(1);
  expect(await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
    nextRunAt: task.nextRunAt,
    lastRunAt: null,
  });
});

it('admits only one of two concurrent reservations', async () => {
  const task = await createTask();
  const results = await Promise.all([reserve(task), reserve(task)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await db.prisma.periodicTaskExecution.count()).toBe(1);
});

it('resolves a legacy monthly anchor from the canonical row and freezes it', async () => {
  vi.setSystemTime(new Date('2024-02-29T17:01:00Z'));
  const task = await createTask({
    cadence: 'MONTHLY',
    timezone: 'America/Los_Angeles',
    createdAt: new Date('2024-02-01T07:30:00Z'),
    scheduledDayOfMonth: null,
    nextRunAt: new Date('2024-02-29T17:00:00Z'),
  });
  const execution = await reserve(task);
  expect(execution).toMatchObject({
    launchSnapshot: {
      cadence: 'MONTHLY',
      timezone: 'America/Los_Angeles',
      scheduledDayOfMonth: 31,
      dueAt: '2024-02-29T17:00:00.000Z',
    },
  });
  expect(await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
    scheduledDayOfMonth: 31,
    nextRunAt: new Date('2024-03-31T16:00:00Z'),
  });
});

it.each([
  ['DAILY', '2024-03-09T14:00:00Z', '2024-03-10T13:01:00Z', null, '2024-03-11T13:00:00Z'],
  ['DAILY', '2024-11-02T13:00:00Z', '2024-11-03T14:01:00Z', null, '2024-11-04T14:00:00Z'],
  ['WEEKLY', '2024-03-03T14:00:00Z', '2024-03-10T13:01:00Z', null, '2024-03-17T13:00:00Z'],
  ['MONTHLY', '2024-01-31T14:00:00Z', '2024-02-29T14:01:00Z', 31, '2024-03-31T13:00:00Z'],
  ['MONTHLY', '2024-01-15T14:00:00Z', '2024-03-10T12:00:00Z', 15, '2024-03-15T13:00:00Z'],
  ['DAILY', '2024-03-01T14:00:00Z', '2024-03-10T12:00:00Z', null, '2024-03-10T13:00:00Z'],
] as const)(
  'preserves %s calendar and catch-up semantics from %s at %s',
  async (cadence, dueAt, now, day, next) => {
    vi.setSystemTime(new Date(now));
    const task = await createTask({
      cadence,
      nextRunAt: new Date(dueAt),
      scheduledDayOfMonth: day,
    });
    await reserve(task);
    expect(
      await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: task.id } })
    ).toMatchObject({
      nextRunAt: new Date(next),
      lastRunAt: new Date(now),
    });
  }
);
