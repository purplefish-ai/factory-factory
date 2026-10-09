import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { githubCLIService, prSnapshotService } from '@/backend/services/github';
import { workspaceDataService, workspacePrSnapshotService } from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

const testDatabase = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!testDatabase.prisma) {
      throw new Error('Integration database not initialized');
    }
    return testDatabase.prisma;
  },
}));

let db: IntegrationDatabase;

const previousPrUrl = 'https://github.com/org/repo/pull/1';
const nextPrUrl = 'https://github.com/org/repo/pull/2';

beforeAll(async () => {
  db = await createIntegrationDatabase();
  testDatabase.prisma = db.prisma;
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
      applyPrSnapshotWithDispatchReset: (id, observation) =>
        workspacePrSnapshotService.applyPrSnapshotWithDispatchReset(id, observation),
      applyPrObservationWithDispatchReset: (id, observation) =>
        workspacePrSnapshotService.applyPrObservationWithDispatchReset(id, observation),
      attachDiscoveredPRIfClaimMatches: (id, prUrl, claim, updatedAt) =>
        workspacePrSnapshotService.attachDiscoveredPRIfClaimMatches(id, prUrl, claim, updatedAt),
      updatePRSnapshotIfUrlMatches: (id, prUrl, snapshot, updatedAt) =>
        workspacePrSnapshotService.updatePRSnapshotIfUrlMatches(id, prUrl, snapshot, updatedAt),
    },
  });
  await db.prisma.project.create({
    data: {
      id: 'pr-project',
      name: 'PR project',
      slug: 'pr-project',
      repoPath: '/tmp/pr-project',
      worktreeBasePath: '/tmp/pr-project-worktrees',
    },
  });
}, 30_000);

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

describe('failed PR attachment recovery', () => {
  it.each(['OPEN', 'MERGED', 'CLOSED'] as const)(
    'preserves a previous %s PR and isolates observations for a newly attached URL',
    async (previousState) => {
      const workspaceId = `pr-${previousState}`;
      await db.prisma.workspace.create({
        data: {
          id: workspaceId,
          name: workspaceId,
          projectId: 'pr-project',
          status: 'READY',
          prs: {
            create: {
              url: previousPrUrl,
              number: 1,
              state: previousState,
              reviewState: 'CHANGES_REQUESTED',
              ciStatus: 'FAILURE',
              hasMergeConflict: true,
            },
          },
          prMonitoring: { create: { enabled: true } },
        },
      });
      vi.spyOn(githubCLIService, 'fetchAndComputePRState').mockResolvedValue(null);

      await expect(prSnapshotService.attachAndRefreshPR(workspaceId, nextPrUrl)).resolves.toEqual({
        success: false,
        reason: 'fetch_failed',
        prId: expect.any(String),
      });

      const neutralCache = await db.prisma.workspacePR.findUniqueOrThrow({
        where: { workspaceId_url: { workspaceId, url: nextPrUrl } },
      });
      expect(neutralCache).toMatchObject({
        url: nextPrUrl,
        number: null,
        state: 'NONE',
        reviewState: null,
        ciStatus: 'UNKNOWN',
        hasMergeConflict: false,
        syncedAt: null,
      });
      // A late observation from the old PR must still be rejected.
      await prSnapshotService.recordPrObservation(workspaceId, {
        prUrl: previousPrUrl,
        prNumber: 1,
        prState: 'MERGED',
        ciStatus: 'SUCCESS',
        reviewState: 'APPROVED',
        hasMergeConflict: false,
      });
      expect(
        await db.prisma.workspacePR.findUniqueOrThrow({
          where: { workspaceId_url: { workspaceId, url: nextPrUrl } },
        })
      ).toEqual(neutralCache);

      await prSnapshotService.recordPrObservation(workspaceId, {
        prUrl: nextPrUrl,
        prNumber: 2,
        prState: 'OPEN',
        ciStatus: 'PENDING',
        reviewState: null,
        hasMergeConflict: true,
      });
      expect(
        await db.prisma.workspacePR.findUniqueOrThrow({
          where: { workspaceId_url: { workspaceId, url: nextPrUrl } },
        })
      ).toMatchObject({
        url: nextPrUrl,
        state: 'OPEN',
        reviewState: null,
        ciStatus: 'PENDING',
        hasMergeConflict: true,
      });
    }
  );
});
