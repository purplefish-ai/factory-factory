import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { githubCLIService, prSnapshotService } from '@/backend/services/github';
import { workspaceDataService, workspacePrSnapshotService } from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test database');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'multi-project',
      name: 'Project',
      slug: 'multi-project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'multi',
      projectId: 'multi-project',
      name: 'Multi',
      branchName: 'workspace-branch',
      status: 'READY',
      prMonitoring: { create: {} },
      prDiscovery: { create: {} },
      prs: {
        create: { id: 'pr-a', url: 'https://github.com/org/repo/pull/1', number: 1, state: 'OPEN' },
      },
    },
  });
  prSnapshotService.configure({
    workspace: {
      listPRs: (id) => workspacePrSnapshotService.list(id),
      findPR: (target) => workspacePrSnapshotService.find(target),
      attachPR: (id, url) => workspacePrSnapshotService.attach(id, url),
      detachPR: (target) => workspacePrSnapshotService.detach(target),
      attachDiscoveredPRsIfClaimMatches: (id, claim, urls) =>
        workspacePrSnapshotService.attachDiscoveredPRsIfClaimMatches(id, claim, urls),
      findPRContext: (id) => workspaceDataService.findPRContext(id),
      recordSnapshot: (id, data) => workspacePrSnapshotService.record(id, data),
      applyPrSnapshotWithDispatchReset: (id, data) =>
        workspacePrSnapshotService.applyPrSnapshotWithDispatchReset(id, data),
      applyPrObservationWithDispatchReset: (id, data) =>
        workspacePrSnapshotService.applyPrObservationWithDispatchReset(id, data),
      attachDiscoveredPRIfClaimMatches: (id, url, claim, at) =>
        workspacePrSnapshotService.attachDiscoveredPRIfClaimMatches(id, url, claim, at),
      updatePRSnapshotIfUrlMatches: (id, url, data, at) =>
        workspacePrSnapshotService.updatePRSnapshotIfUrlMatches(id, url, data, at),
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('adds another PR without replacing its sibling or changing the workspace branch', async () => {
  vi.spyOn(githubCLIService, 'fetchAndComputePRState').mockResolvedValue({
    prNumber: 2,
    prState: 'OPEN',
    prReviewState: null,
    prCiStatus: 'PENDING',
    headRefName: 'other-branch',
  });
  await prSnapshotService.attachAndRefreshPR('multi', 'https://github.com/org/repo/pull/2');
  expect(
    await db.prisma.workspacePR.count({ where: { workspaceId: 'multi', detachedAt: null } })
  ).toBe(2);
  expect(await db.prisma.workspacePR.findUnique({ where: { id: 'pr-a' } })).toMatchObject({
    url: 'https://github.com/org/repo/pull/1',
  });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'multi' } })).toMatchObject({
    branchName: 'workspace-branch',
  });
});
