import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { formatArchiveIncompleteMessage } from './workspace-archive-incomplete';

let db: IntegrationDatabase;
let workspaceAccessor: typeof import('./workspace.accessor').workspaceAccessor;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ workspaceAccessor } =
    await vi.importActual<typeof import('./workspace.accessor')>('./workspace.accessor'));
}, 30_000);
afterEach(async () => {
  await db.prisma.workspace.deleteMany();
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function createFailedWorkspace(initErrorMessage: string | null) {
  const project = await db.prisma.project.create({
    data: { name: 'P', slug: `p-${Math.random()}`, repoPath: '/repo', worktreeBasePath: '/wt' },
  });
  const workspace = await workspaceAccessor.create({ projectId: project.id, name: 'W' });
  await db.prisma.workspace.update({
    where: { id: workspace.id },
    data: { status: 'FAILED', initErrorMessage },
  });
  return workspace.id;
}

it.each([
  ['retry setup', 'startProvisioningRetryIfAllowed'],
  ['recreate the worktree', 'resetToNewIfAllowed'],
] as const)('a racing %s cannot restart an incomplete archive', async (_name, method) => {
  const incomplete = await createFailedWorkspace(formatArchiveIncompleteMessage('remove failed'));
  const withoutMessage = await createFailedWorkspace(null);
  const setupFailure = await createFailedWorkspace('Setup script failed');

  await expect(workspaceAccessor[method](incomplete, 3)).resolves.toEqual({ count: 0 });
  await expect(workspaceAccessor[method](withoutMessage, 3)).resolves.toEqual({
    count: 1,
  });
  await expect(workspaceAccessor[method](setupFailure, 3)).resolves.toEqual({ count: 1 });
  expect(await db.prisma.workspace.findUnique({ where: { id: incomplete } })).toMatchObject({
    status: 'FAILED',
    initRetryCount: 0,
  });
});
