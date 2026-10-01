import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { githubCLIService, prSnapshotService } from '@/backend/services/github';
import {
  workspaceDataService,
  workspacePrSnapshotService,
  workspaceRatchetService,
} from '@/backend/services/workspace';
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
    'clears a previous %s PR and accepts ratchet observations for the new URL',
    async (previousState) => {
      const workspaceId = `pr-${previousState}`;
      await db.prisma.workspace.create({
        data: {
          id: workspaceId,
          name: workspaceId,
          projectId: 'pr-project',
          status: 'READY',
          pr: {
            create: {
              url: previousPrUrl,
              number: 1,
              state: previousState,
              reviewState: 'CHANGES_REQUESTED',
              ciStatus: 'FAILURE',
            },
          },
          ratchet: { create: { enabled: true } },
        },
      });
      vi.spyOn(githubCLIService, 'fetchAndComputePRState').mockResolvedValue(null);

      await expect(prSnapshotService.attachAndRefreshPR(workspaceId, nextPrUrl)).resolves.toEqual({
        success: false,
        reason: 'fetch_failed',
      });

      const neutralCache = await db.prisma.workspacePR.findUniqueOrThrow({
        where: { workspaceId },
      });
      expect(neutralCache).toMatchObject({
        url: nextPrUrl,
        number: null,
        state: 'NONE',
        reviewState: null,
        ciStatus: 'UNKNOWN',
        syncedAt: expect.any(Date),
      });
      expect(await workspaceRatchetService.findCandidates()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: workspaceId, prUrl: nextPrUrl })])
      );

      // A late observation from the old PR must still be rejected.
      await prSnapshotService.recordPrObservation(workspaceId, {
        prUrl: previousPrUrl,
        prNumber: 1,
        prState: 'MERGED',
        ciStatus: 'SUCCESS',
        reviewState: 'APPROVED',
        hasMergeConflict: false,
      });
      expect(await db.prisma.workspacePR.findUniqueOrThrow({ where: { workspaceId } })).toEqual(
        neutralCache
      );

      await prSnapshotService.recordPrObservation(workspaceId, {
        prUrl: nextPrUrl,
        prNumber: 2,
        prState: 'OPEN',
        ciStatus: 'PENDING',
        reviewState: null,
        hasMergeConflict: true,
      });
      expect(
        await db.prisma.workspacePR.findUniqueOrThrow({ where: { workspaceId } })
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
