import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let workspaceAccessor: typeof import('./workspace.accessor').workspaceAccessor;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ workspaceAccessor } =
    await vi.importActual<typeof import('./workspace.accessor')>('./workspace.accessor'));
}, 30_000);
afterEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.periodicTask.deleteMany();
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function createProject(slug = 'target') {
  return db.prisma.project.create({
    data: { name: slug, slug, repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
}

const creationSources = [
  undefined,
  'MANUAL',
  'RESUME_BRANCH',
  'GITHUB_ISSUE',
  'LINEAR_ISSUE',
  'PERIODIC_TASK',
  'CHILD_WORKSPACE',
] as const;

it.each(creationSources)(
  'rejects %s creation when the project archives before insertion',
  async (creationSource) => {
    const project = await createProject();
    const preflight = await db.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(preflight.isArchived).toBe(false);
    await db.prisma.project.update({ where: { id: project.id }, data: { isArchived: true } });

    await expect(
      workspaceAccessor.create({ projectId: project.id, name: 'Rejected', creationSource })
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(await db.prisma.workspace.count()).toBe(0);
    expect(await db.prisma.workspacePRMonitoring.count()).toBe(0);
    expect(await db.prisma.workspacePRDiscovery.count()).toBe(0);
    expect(await db.prisma.workspaceRunScript.count()).toBe(0);
  }
);

it.each(creationSources)(
  'creates %s workspaces in active projects with related rows',
  async (creationSource) => {
    const project = await createProject();
    const parent = await workspaceAccessor.create({ projectId: project.id, name: 'Parent' });
    const task = await db.prisma.periodicTask.create({
      data: {
        projectId: project.id,
        name: 'Agent',
        prompt: 'Instructions',
        cadence: 'DAILY',
        nextRunAt: new Date(0),
      },
    });
    const workspace = await workspaceAccessor.create({
      projectId: project.id,
      name: 'Allowed',
      creationSource,
      parentWorkspaceId: creationSource === 'CHILD_WORKSPACE' ? parent.id : undefined,
      periodicTaskId: creationSource === 'PERIODIC_TASK' ? task.id : undefined,
    });

    expect(workspace).toMatchObject({
      projectId: project.id,
      parentWorkspaceId: creationSource === 'CHILD_WORKSPACE' ? parent.id : null,
      periodicTaskId: creationSource === 'PERIODIC_TASK' ? task.id : null,
    });
    expect(await db.prisma.workspacePRMonitoring.count()).toBe(2);
    expect(await db.prisma.workspacePRDiscovery.count()).toBe(2);
    expect(await db.prisma.workspaceRunScript.count()).toBe(2);
  }
);
