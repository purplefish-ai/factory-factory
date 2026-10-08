import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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
      ratchet: { create: {} },
      prDiscovery: { create: {} },
      prs: {
        create: {
          id: 'pr-a',
          url: 'https://github.com/org/repo/pull/1',
          number: 1,
          state: 'OPEN',
          automation: { create: { dispatchOutcome: 'COMPLETED', dispatchSnapshotKey: 'a-done' } },
        },
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
      applyPrSnapshotWithDispatchReset: (id, data) =>
        workspacePrSnapshotService.applyPrSnapshotWithDispatchReset(id, data),
      applyPrObservationWithDispatchReset: (id, data) =>
        workspacePrSnapshotService.applyPrObservationWithDispatchReset(id, data),
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
  expect(
    await db.prisma.workspacePR.findUnique({ where: { id: 'pr-a' }, include: { automation: true } })
  ).toMatchObject({
    url: 'https://github.com/org/repo/pull/1',
    automation: { dispatchSnapshotKey: 'a-done', dispatchOutcome: 'COMPLETED' },
  });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'multi' } })).toMatchObject({
    branchName: 'workspace-branch',
  });
});

it('clears only a removed PR ownership and rejects stale dispatch claims', async () => {
  const attached = await workspacePrSnapshotService.attach(
    'multi',
    'https://github.com/other/repo/pull/1'
  );
  const pr = await workspacePrSnapshotService.find({ workspaceId: 'multi', prId: attached.prId });
  expect(pr).not.toBeNull();
  expect(
    await workspaceRatchetService.recordDispatchIfEnabled('multi', {
      prId: attached.prId,
      expectedRevision: pr!.revision,
      sessionId: 'fixer-a',
      snapshotKey: 'a',
      retryCount: 0,
    })
  ).toBe(true);
  await workspacePrSnapshotService.detach({ workspaceId: 'multi', prId: attached.prId });
  expect(
    await db.prisma.workspaceRatchet.findUnique({ where: { workspaceId: 'multi' } })
  ).toMatchObject({ activePrId: null, activeSessionId: null });
  await workspacePrSnapshotService.attach('multi', pr!.url);
  expect(
    await workspaceRatchetService.recordDispatchIfEnabled('multi', {
      prId: attached.prId,
      expectedRevision: pr!.revision,
      sessionId: 'late',
      snapshotKey: 'a',
      retryCount: 0,
    })
  ).toBe(false);
});

it('rejects a refresh started before detach and reattach', async () => {
  const attached = await workspacePrSnapshotService.attach(
    'multi',
    'https://github.com/other/repo/pull/8'
  );
  let resolve!: (
    value: Awaited<ReturnType<typeof githubCLIService.fetchAndComputePRState>>
  ) => void;
  vi.spyOn(githubCLIService, 'fetchAndComputePRState').mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const refresh = prSnapshotService.refreshPR({ workspaceId: 'multi', prId: attached.prId });
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await workspacePrSnapshotService.detach({ workspaceId: 'multi', prId: attached.prId });
  await workspacePrSnapshotService.attach('multi', 'https://github.com/other/repo/pull/8');
  resolve({
    prNumber: 8,
    prState: 'MERGED',
    prCiStatus: 'SUCCESS',
    prReviewState: null,
    headRefName: 'old',
  });
  expect(await refresh).toEqual({ success: false, reason: 'stale_observation' });
  expect(
    await workspacePrSnapshotService.find({ workspaceId: 'multi', prId: attached.prId })
  ).toMatchObject({ state: 'NONE' });
});
