import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { workspacePrAccessor } from '@/backend/services/workspace/resources/workspace-pr.accessor';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { workspacePrSnapshotService } from './workspace-pr-snapshot.service';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'w',
      projectId: 'project',
      name: 'Workspace',
      status: 'READY',
      branchName: 'feature',
      prMonitoring: { create: { enabled: true } },
      prDiscovery: { create: {} },
    },
  });
});
function createPR(id = 'p', extra = {}) {
  return db.prisma.workspacePR.create({
    data: {
      id,
      workspaceId: 'w',
      url: `https://github.com/org/repo/pull/${id === 'p' ? 1 : 2}`,
      ...extra,
    },
  });
}
it('legacy snapshot writes honor explicit association identity and revision', async () => {
  await createPR('p', { state: 'OPEN', revision: 2 });
  await createPR('p2', { state: 'OPEN', revision: 4 });
  await workspacePrSnapshotService.record('w', {
    prId: 'p2',
    expectedRevision: 3,
    prState: 'MERGED',
  });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p2' })).toMatchObject({
    state: 'OPEN',
    revision: 4,
  });
  await workspacePrSnapshotService.record('w', {
    prId: 'p2',
    expectedRevision: 4,
    prState: 'MERGED',
  });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p2' })).toMatchObject({
    state: 'MERGED',
    revision: 5,
  });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p' })).toMatchObject({
    state: 'OPEN',
    revision: 2,
  });
});
