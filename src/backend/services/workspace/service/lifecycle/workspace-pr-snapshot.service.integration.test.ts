import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { workspacePrAccessor } from '@/backend/services/workspace/resources/workspace-pr.accessor';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';
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
it('monitored observations honor explicit association identity and revision', async () => {
  await createPR('p', { state: 'OPEN', revision: 2 });
  await createPR('p2', { state: 'OPEN', revision: 4 });
  const input = {
    target: { workspaceId: 'w', prId: 'p2' },
    expectedEventEpoch: 0,
    expectedPrRevision: 3,
    observation: {
      ...redObservation,
      url: 'https://github.com/org/repo/pull/2',
      number: 2,
      headBranch: 'different-head',
      prState: 'MERGED' as const,
    },
  };
  expect(await workspacePrSnapshotService.acceptMonitoredObservation(input)).toEqual({
    applied: false,
    eventIds: [],
  });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p2' })).toMatchObject({
    state: 'OPEN',
    revision: 4,
  });
  expect(
    await workspacePrSnapshotService.acceptMonitoredObservation({
      ...input,
      expectedPrRevision: 4,
      observation: { ...input.observation, url: redObservation.url },
    })
  ).toEqual({ applied: false, eventIds: [] });
  expect(
    await workspacePrSnapshotService.acceptMonitoredObservation({
      ...input,
      expectedPrRevision: 4,
    })
  ).toMatchObject({ applied: true });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p2' })).toMatchObject({
    state: 'MERGED',
    revision: 5,
    headRefName: 'different-head',
  });
  expect(await workspacePrAccessor.findByIdentity({ workspaceId: 'w', prId: 'p' })).toMatchObject({
    state: 'OPEN',
    revision: 2,
  });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'w' } })).toMatchObject({
    branchName: 'feature',
  });
});
