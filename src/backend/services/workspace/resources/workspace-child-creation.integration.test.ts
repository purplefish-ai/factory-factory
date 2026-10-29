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
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function createParentAndTarget() {
  const project = await db.prisma.project.create({
    data: {
      name: 'Target project',
      slug: 'target',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  const parent = await workspaceAccessor.create({ projectId: project.id, name: 'Parent' });
  return { project, parent };
}

it('rejects a child when archival commits after preflight but before insertion', async () => {
  const { project, parent } = await createParentAndTarget();
  const preflight = await db.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  expect(preflight.isArchived).toBe(false);
  await db.prisma.project.update({ where: { id: project.id }, data: { isArchived: true } });

  await expect(
    workspaceAccessor.create({
      projectId: project.id,
      parentWorkspaceId: parent.id,
      name: 'Rejected child',
      creationSource: 'CHILD_WORKSPACE',
    })
  ).rejects.toMatchObject({ code: 'P2025' });
  expect(await db.prisma.workspace.count({ where: { parentWorkspaceId: parent.id } })).toBe(0);
});

it('creates an active-project child with its parent and side-table rows', async () => {
  const { project, parent } = await createParentAndTarget();
  const child = await workspaceAccessor.create({
    projectId: project.id,
    parentWorkspaceId: parent.id,
    name: 'Active child',
    creationSource: 'CHILD_WORKSPACE',
  });
  expect(child).toMatchObject({ projectId: project.id, parentWorkspaceId: parent.id });
  expect(
    await db.prisma.workspace.findUnique({
      where: { id: child.id },
      include: { prMonitoring: true, prDiscovery: true, runScript: true },
    })
  ).toMatchObject({
    prMonitoring: expect.objectContaining({ workspaceId: child.id }),
    prDiscovery: expect.objectContaining({ workspaceId: child.id }),
    runScript: expect.objectContaining({ workspaceId: child.id }),
  });
});
