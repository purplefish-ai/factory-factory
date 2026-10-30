import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let periodicTaskAccessor: typeof import('./periodic-task.accessor').periodicTaskAccessor;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ periodicTaskAccessor } = await vi.importActual<typeof import('./periodic-task.accessor')>(
    './periodic-task.accessor'
  ));
}, 30_000);
afterEach(async () => {
  await db.prisma.periodicTask.deleteMany();
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
function createProject(slug: string) {
  return db.prisma.project.create({
    data: { name: slug, slug, repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
}

it('skips archived projects during due-task polling and resumes eligible tasks after unarchiving', async () => {
  const active = await createProject('active');
  const archived = await createProject('archived');
  await db.prisma.project.update({ where: { id: archived.id }, data: { isArchived: true } });
  const taskData = {
    name: 'Agent',
    prompt: 'Instructions',
    cadence: 'DAILY' as const,
    nextRunAt: new Date(0),
  };
  const due = await db.prisma.periodicTask.create({ data: { ...taskData, projectId: active.id } });
  const paused = await db.prisma.periodicTask.create({
    data: { ...taskData, projectId: archived.id },
  });
  await db.prisma.periodicTask.create({
    data: { ...taskData, projectId: active.id, isEnabled: false },
  });
  await db.prisma.periodicTask.create({
    data: { ...taskData, projectId: active.id, nextRunAt: new Date('2100-01-01') },
  });

  expect((await periodicTaskAccessor.findDueTasks()).map((task) => task.id)).toEqual([due.id]);
  expect(await db.prisma.periodicTask.findUnique({ where: { id: paused.id } })).toMatchObject({
    isEnabled: true,
    nextRunAt: new Date(0),
  });
  await db.prisma.project.update({ where: { id: archived.id }, data: { isArchived: false } });
  expect((await periodicTaskAccessor.findDueTasks()).map((task) => task.id).sort()).toEqual(
    [due.id, paused.id].sort()
  );
});
