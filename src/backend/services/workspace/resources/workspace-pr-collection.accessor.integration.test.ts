import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { Prisma, PrismaClient } from '@prisma-gen/client';
import { workspacePrDiscoveryAccessor } from './workspace-pr-discovery.accessor';
import {
  flattenWorkspacePR,
  projectWorkspacePRCollection,
  WORKSPACE_PR_DEFAULTS,
  workspacePrAccessor,
} from './workspace-pr.accessor';
import { workspaceRatchetAccessor } from './workspace-ratchet.accessor';
import { workspaceAccessor } from './workspace.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing database');
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
      id: 'project',
      name: 'P',
      slug: 'p',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
async function workspace(id: string) {
  return await db.prisma.workspace.create({
    data: {
      id,
      projectId: 'project',
      name: id,
      branchName: 'feature',
      status: 'READY',
      prMonitoring: { create: { enabled: true } },
      prDiscovery: { create: {} },
    },
  });
}
it('uses fresh defaults when no PR exists', () => {
  const first = flattenWorkspacePR(null);
  first.prNumber = 99;
  const second = flattenWorkspacePR(undefined);
  expect(second).not.toBe(first);
  expect(second.prNumber).toBeNull();
  expect(WORKSPACE_PR_DEFAULTS.prNumber).toBeNull();
  expect(second).toEqual(WORKSPACE_PR_DEFAULTS);
});
it('advances collection revision across attachment, detachment, and reattachment without exposing tombstones', async () => {
  const row = await workspace('membership-revision');
  const read = async (revision: number, ids: string[]) => {
    for (const projection of [
      await workspaceAccessor.findById(row.id),
      await workspaceAccessor.findByIdWithProject(row.id),
      await workspaceRatchetAccessor.findSnapshotProjection(row.id),
      (await workspaceAccessor.findAllNonArchivedWithSessionsAndProject()).find(
        (candidate) => candidate.id === row.id
      ),
    ]) {
      expect(projection).toMatchObject({ prCollectionRevision: revision });
      expect(projection?.prs.map((pr) => pr.id).sort()).toEqual(ids.slice().sort());
    }
  };
  await read(0, []);
  const first = await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/1');
  await read(1, [first.prId]);
  await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/1');
  await read(1, [first.prId]);
  const second = await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/2');
  await read(2, [first.prId, second.prId]);
  await workspacePrAccessor.detach({ workspaceId: row.id, prId: first.prId });
  await read(3, [second.prId]);
  await workspacePrAccessor.detach({ workspaceId: row.id, prId: second.prId });
  await read(4, []);
  expect(
    projectWorkspacePRCollection(await workspacePrAccessor.list(row.id), true)
  ).not.toHaveProperty('prCollectionRevision');
  expect(await db.prisma.workspacePR.count({ where: { workspaceId: row.id } })).toBe(2);
  await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/1');
  await read(5, [first.prId]);
});
it('keeps same-numbered PRs in different repositories independent and duplicate attachment idempotent', async () => {
  await workspace('identity');
  const a = await workspacePrAccessor.attach('identity', 'https://github.com/org/repo/pull/1');
  const b = await workspacePrAccessor.attach('identity', 'https://github.com/other/repo/pull/1');
  expect(a.prId).not.toBe(b.prId);
  expect(
    await workspacePrAccessor.attach('identity', 'https://github.com/org/repo/pull/1')
  ).toEqual({ ...a, created: false });
  expect(await workspacePrAccessor.list('identity')).toHaveLength(2);
  expect(
    await workspacePrAccessor.findByIdentity({ workspaceId: 'other-workspace', prId: a.prId })
  ).toBeNull();
  expect(await workspacePrAccessor.findPRState('identity')).toMatchObject({
    prUrl: 'https://github.com/org/repo/pull/1',
  });
});
it('treats owner/repo casing variants of one PR URL as the same association', async () => {
  const row = await workspace('casing');
  const pasted = await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/7');
  expect(await workspacePrAccessor.attach(row.id, 'https://github.com/Org/Repo/pull/7')).toEqual({
    ...pasted,
    created: false,
  });
  const checkedAt = new Date();
  const claim = {
    githubOwner: 'org',
    githubRepo: 'repo',
    branchName: 'feature',
    checkedAt,
    retryCount: 0,
    nextCheckAt: new Date(checkedAt.getTime() + 60_000),
  };
  await db.prisma.workspacePRDiscovery.update({
    where: { workspaceId: row.id },
    data: { lastCheckedAt: claim.checkedAt, nextCheckAt: claim.nextCheckAt },
  });
  const discovered = await workspacePrAccessor.attachDiscoveredPRsIfClaimMatches(row.id, claim, [
    'https://github.com/ORG/repo/pull/7',
    'https://github.com/org/repo/pull/70',
  ]);
  expect(discovered).toHaveLength(1);
  await workspacePrAccessor.detach({ workspaceId: row.id, prId: pasted.prId });
  expect(await workspacePrAccessor.attach(row.id, 'https://GitHub.com/ORG/REPO/pull/7')).toEqual({
    prId: pasted.prId,
    created: false,
    reattached: true,
  });
  expect((await workspacePrAccessor.list(row.id)).map((pr) => pr.id).sort()).toEqual(
    [pasted.prId, discovered[0]].sort()
  );
});
it('finds review-request associations by PR identity regardless of URL casing', async () => {
  const row = await workspace('review-casing');
  await workspacePrAccessor.attach(row.id, 'https://github.com/org/review/pull/5');
  await workspacePrAccessor.attach(row.id, 'https://github.com/org/review/pull/15');
  await db.prisma.workspace.update({ where: { id: row.id }, data: { status: 'ARCHIVED' } });
  expect(
    await workspacePrAccessor.findReviewRequestAssociations([
      'https://github.com/Org/Review/pull/5',
      'https://github.com/org/review/pull/50',
    ])
  ).toEqual([{ url: 'https://github.com/Org/Review/pull/5', workspace: { status: 'ARCHIVED' } }]);
  // A full GitHub search page can list ~1,000 PRs; lookups must stay below SQLite's limits.
  const urls = Array.from(
    { length: 1200 },
    (_, i) => `https://github.com/Org/Review/pull/${i + 1}`
  );
  expect((await workspacePrAccessor.findReviewRequestAssociations(urls)).map((a) => a.url)).toEqual(
    [urls[4], urls[14]]
  );
});
it('reads every restored cache field on its explicit PR', async () => {
  await workspace('cache');
  const { prId } = await workspacePrAccessor.attach('cache', 'https://github.com/org/repo/pull/7');
  const at = new Date();
  await db.prisma.workspacePR.update({
    where: { id: prId },
    data: {
      number: 7,
      state: 'APPROVED',
      ciStatus: 'SUCCESS',
      reviewState: 'APPROVED',
      hasMergeConflict: true,
      syncedAt: at,
      ciFailedAt: at,
      ciLastNotifiedAt: at,
      reviewLastCheckedAt: at,
      reviewLastCommentId: 'comment',
      title: 'Title',
      headRefName: 'head',
      baseRefName: 'main',
    },
  });
  const pr = await workspacePrAccessor.findByIdentity({ workspaceId: 'cache', prId });
  expect(pr).toMatchObject({
    number: 7,
    state: 'APPROVED',
    ciStatus: 'SUCCESS',
    reviewState: 'APPROVED',
    hasMergeConflict: true,
    syncedAt: at,
    reviewLastCommentId: 'comment',
    title: 'Title',
    headRefName: 'head',
    baseRefName: 'main',
  });
  expect(flattenWorkspacePR(pr)).toMatchObject({
    prUpdatedAt: at,
    prCiFailedAt: at,
    prCiLastNotifiedAt: at,
    prReviewLastCheckedAt: at,
  });
});
it('rejects stale observation revisions and cross-workspace updates', async () => {
  await workspace('cas');
  const { prId } = await workspacePrAccessor.attach('cas', redObservation.url);
  const input = {
    target: { workspaceId: 'cas', prId },
    expectedPrRevision: 0,
    expectedEventEpoch: 0,
    observation: redObservation,
  };
  expect(await workspacePrAccessor.acceptMonitoredObservation(input)).toMatchObject({
    applied: true,
  });
  expect(await workspacePrAccessor.acceptMonitoredObservation(input)).toEqual({
    applied: false,
    eventIds: [],
  });
  expect(
    await workspacePrAccessor.acceptMonitoredObservation({
      ...input,
      target: { workspaceId: 'different', prId },
      expectedPrRevision: 1,
    })
  ).toEqual({ applied: false, eventIds: [] });
});
it('attaches discovery matches atomically while preserving tombstones and duplicates', async () => {
  const row = await workspace('discovery');
  const checkedAt = new Date(),
    nextCheckAt = new Date(checkedAt.getTime() + 60_000);
  expect(
    await workspacePrDiscoveryAccessor.claimDiscoveryAttempt(row.id, {
      branchName: 'feature',
      expectedUpdatedAt: row.updatedAt,
      expectedRetryCount: 0,
      expectedNextCheckAt: null,
      checkedAt,
      nextCheckAt,
    })
  ).toBe(true);
  const claim = {
    githubOwner: 'org',
    githubRepo: 'repo',
    branchName: 'feature',
    checkedAt,
    retryCount: 1,
    nextCheckAt,
  };
  const urls = [1, 2, 3].map((n) => `https://github.com/org/repo/pull/${n}`);
  const ids = await workspacePrAccessor.attachDiscoveredPRsIfClaimMatches(row.id, claim, urls);
  expect(ids).toHaveLength(3);
  await workspacePrAccessor.detach({ workspaceId: row.id, prId: ids[0]! });
  expect(await workspacePrAccessor.attachDiscoveredPRsIfClaimMatches(row.id, claim, urls)).toEqual(
    []
  );
  expect(await workspacePrAccessor.list(row.id)).toHaveLength(2);
  await db.prisma.workspace.update({ where: { id: row.id }, data: { branchName: 'renamed' } });
  expect(
    await workspacePrAccessor.attachDiscoveredPRsIfClaimMatches(row.id, claim, [
      'https://github.com/org/repo/pull/4',
    ])
  ).toEqual([]);
  expect((await workspacePrAccessor.attach(row.id, urls[0]!)).reattached).toBe(true);
});
it('discovers workspaces that already have PRs and syncs terminal PRs so reopening is observable', async () => {
  const row = await workspace('existing');
  const { prId } = await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/20');
  await db.prisma.workspacePR.update({ where: { id: prId }, data: { state: 'MERGED' } });
  expect(await workspacePrAccessor.findNeedingDiscovery(100)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: row.id })])
  );
  expect(await workspacePrAccessor.findNeedingSync()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: row.id, prId })])
  );
  await workspacePrDiscoveryAccessor.clearDiscoverySchedule(db.prisma, row.id);
  expect(
    await db.prisma.workspacePRDiscovery.findUnique({ where: { workspaceId: row.id } })
  ).toMatchObject({ retryCount: 0, nextCheckAt: null });
});

it('projects aggregate CI and state in workspace reads with project metadata', async () => {
  const row = await workspace('project-summary');
  const a = await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/30');
  const b = await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/31');
  await db.prisma.workspacePR.update({
    where: { id: a.prId },
    data: { state: 'MERGED', ciStatus: 'SUCCESS' },
  });
  await db.prisma.workspacePR.update({
    where: { id: b.prId },
    data: { state: 'OPEN', ciStatus: 'FAILURE' },
  });
  expect(await workspaceAccessor.findByIdWithProject(row.id)).toMatchObject({
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
    prSummary: { hasNonterminal: true },
  });
});

it('reports a deterministic historical PR link when periodic work creates several PRs', async () => {
  const row = await workspace('periodic-links');
  await db.prisma.workspacePR.createMany({
    data: [
      {
        id: 'periodic-z',
        workspaceId: row.id,
        url: 'https://github.com/org/repo/pull/40',
        number: 40,
      },
      {
        id: 'periodic-a',
        workspaceId: row.id,
        url: 'https://github.com/org/repo/pull/41',
        number: 41,
      },
      {
        id: 'periodic-0',
        workspaceId: row.id,
        url: 'https://github.com/org/repo/pull/39',
        number: 39,
        detachedAt: new Date(),
      },
    ],
  });
  expect(await workspaceAccessor.findStatusSnapshot(row.id)).toMatchObject({
    prUrl: 'https://github.com/org/repo/pull/41',
    prNumber: 41,
  });
  expect(await workspaceAccessor.findPRContext(row.id)).toMatchObject({
    prUrl: 'https://github.com/org/repo/pull/41',
  });
});

it('serializes concurrent duplicate attachment into a single PR association', async () => {
  await workspace('concurrent-attachment');
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      workspacePrAccessor.attach('concurrent-attachment', 'https://github.com/org/repo/pull/88')
    )
  );
  expect(new Set(results.map((r) => r.prId)).size).toBe(1);
  expect(results.filter((r) => r.created)).toHaveLength(1);
  expect(await workspacePrAccessor.list('concurrent-attachment')).toHaveLength(1);
});

it('respects disabled monitoring state in every project metadata read', async () => {
  const row = await workspace('disabled-project-summary');
  const { prId } = await workspacePrAccessor.attach(row.id, 'https://github.com/org/repo/pull/90');
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: row.id },
    data: { enabled: false },
  });
  await db.prisma.workspacePR.update({
    where: { id: prId },
    data: { state: 'OPEN', ciStatus: 'FAILURE' },
  });
  const expected = { prSummary: { ratchetState: 'IDLE' } };
  expect(await workspaceAccessor.findByIdWithProject(row.id)).toMatchObject(expected);
  expect((await workspaceAccessor.findByIdsWithProject([row.id]))[0]).toMatchObject(expected);
  await db.prisma.workspace.create({
    data: { id: 'disabled-child', projectId: 'project', name: 'Child', parentWorkspaceId: row.id },
  });
  expect(await workspaceAccessor.findParentWorkspace('disabled-child')).toMatchObject(expected);
  await db.prisma.workspace.update({ where: { id: row.id }, data: { status: 'NEW' } });
  expect(
    (await workspaceAccessor.findNeedingWorktree()).find((w) => w.id === row.id)
  ).toMatchObject(expected);
  await db.prisma.workspace.update({
    where: { id: row.id },
    data: { status: 'ARCHIVING', updatedAt: new Date('2025-01-01') },
  });
  expect(
    (await workspaceAccessor.findStaleArchivingWithProject()).find((w) => w.id === row.id)
  ).toMatchObject(expected);
});

it('keeps scalar PR selection stable across workspace and ratchet snapshot reads', async () => {
  const row = await workspace('snapshot-order');
  await db.prisma.workspacePR.createMany({
    data: [
      {
        id: 'snapshot-z',
        workspaceId: row.id,
        url: 'https://github.com/org/repo/pull/102',
        number: 102,
        state: 'OPEN',
        syncedAt: new Date('2026-10-17T12:00:00Z'),
      },
      {
        id: 'snapshot-a',
        workspaceId: row.id,
        url: 'https://github.com/org/repo/pull/101',
        number: 101,
        state: 'OPEN',
        syncedAt: new Date('2026-10-17T11:00:00Z'),
      },
    ],
  });
  const expected = { prNumber: 101, prUpdatedAt: new Date('2026-10-17T11:00:00Z') };
  expect(await workspaceAccessor.findById(row.id)).toMatchObject(expected);
  expect(await workspaceAccessor.findByIdWithProject(row.id)).toMatchObject(expected);
  expect(await workspaceRatchetAccessor.findSnapshotProjection(row.id)).toMatchObject(expected);
});

it.each<{
  name: string;
  enabled: boolean;
  prs: Pick<
    Prisma.WorkspacePRCreateManyInput,
    'state' | 'ciStatus' | 'detachedAt' | 'hasMergeConflict'
  >[];
  selected: number | null;
  state: string;
  ciStatus: string;
  conflict: boolean;
  ratchetState: string;
  openCount: number;
}>([
  {
    name: 'no PR',
    enabled: true,
    prs: [],
    selected: null,
    state: 'NONE',
    ciStatus: 'UNKNOWN',
    conflict: false,
    ratchetState: 'IDLE',
    openCount: 0,
  },
  {
    name: 'detached PR',
    enabled: true,
    prs: [{ state: 'OPEN', ciStatus: 'FAILURE', detachedAt: new Date('2026-10-01') }],
    selected: null,
    state: 'NONE',
    ciStatus: 'UNKNOWN',
    conflict: false,
    ratchetState: 'IDLE',
    openCount: 0,
  },
  {
    name: 'closed siblings',
    enabled: true,
    prs: [
      { state: 'MERGED', ciStatus: 'SUCCESS' },
      { state: 'CLOSED', ciStatus: 'FAILURE' },
    ],
    selected: 0,
    state: 'CLOSED',
    ciStatus: 'UNKNOWN',
    conflict: false,
    ratchetState: 'IDLE',
    openCount: 0,
  },
  {
    name: 'active sibling',
    enabled: true,
    prs: [
      { state: 'CLOSED', ciStatus: 'FAILURE', hasMergeConflict: true },
      { state: 'OPEN', ciStatus: 'SUCCESS' },
    ],
    selected: 1,
    state: 'OPEN',
    ciStatus: 'SUCCESS',
    conflict: false,
    ratchetState: 'READY',
    openCount: 1,
  },
  {
    name: 'mixed CI siblings',
    enabled: true,
    prs: [
      { state: 'OPEN', ciStatus: 'SUCCESS' },
      { state: 'OPEN', ciStatus: 'PENDING' },
      { state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: true },
    ],
    selected: 0,
    state: 'OPEN',
    ciStatus: 'FAILURE',
    conflict: true,
    ratchetState: 'CI_FAILED',
    openCount: 3,
  },
  {
    name: 'disabled monitoring',
    enabled: false,
    prs: [{ state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: true }],
    selected: 0,
    state: 'OPEN',
    ciStatus: 'FAILURE',
    conflict: true,
    ratchetState: 'IDLE',
    openCount: 1,
  },
])(
  'preserves scalar, collection and discovery fields for $name across workspace readers',
  async (testCase) => {
    const row = await workspace(`projection-${testCase.name}`);
    const checkedAt = new Date('2026-10-20T12:00:00Z');
    const nextCheckAt = new Date('2026-10-20T12:10:00Z');
    const syncedAt = new Date('2026-10-20T11:00:00Z');
    await db.prisma.workspacePRMonitoring.update({
      where: { workspaceId: row.id },
      data: { enabled: testCase.enabled },
    });
    await db.prisma.workspacePRDiscovery.update({
      where: { workspaceId: row.id },
      data: { lastCheckedAt: checkedAt, retryCount: 4, nextCheckAt },
    });
    for (const [index, pr] of testCase.prs.entries()) {
      await db.prisma.workspacePR.create({
        data: {
          id: `${row.id}-${index}`,
          workspaceId: row.id,
          url: `https://github.com/org/repo/pull/${100 + index}`,
          number: 100 + index,
          title: `PR ${index}`,
          headRefName: `feature-${index}`,
          baseRefName: 'main',
          syncedAt,
          reviewState: 'REVIEW_REQUIRED',
          ciFailedAt: checkedAt,
          ciLastNotifiedAt: checkedAt,
          reviewLastCheckedAt: checkedAt,
          reviewLastCommentId: `comment-${index}`,
          ...pr,
        },
      });
    }
    const full = await workspaceAccessor.findById(row.id);
    const project = await workspaceAccessor.findByIdWithProject(row.id);
    const selected = testCase.selected;
    const expected = {
      prUrl: selected === null ? null : `https://github.com/org/repo/pull/${100 + selected}`,
      prNumber: selected === null ? null : 100 + selected,
      prState: testCase.state,
      prReviewState: selected === null ? null : 'REVIEW_REQUIRED',
      prCiStatus: testCase.ciStatus,
      prHasMergeConflict: testCase.conflict,
      prUpdatedAt: selected === null ? null : syncedAt,
      prCiFailedAt: selected === null ? null : checkedAt,
      prCiLastNotifiedAt: selected === null ? null : checkedAt,
      prReviewLastCheckedAt: selected === null ? null : checkedAt,
      prReviewLastCommentId: selected === null ? null : `comment-${selected}`,
      prDiscoveryLastCheckedAt: checkedAt,
      prDiscoveryRetryCount: 4,
      prDiscoveryNextCheckAt: nextCheckAt,
      prSummary: {
        totalCount: testCase.prs.filter((pr) => !pr.detachedAt).length,
        openCount: testCase.openCount,
        hasNonterminal: testCase.openCount > 0,
        state: testCase.state,
        ciStatus: testCase.ciStatus,
        hasMergeConflict: testCase.conflict,
        ratchetState: testCase.ratchetState,
      },
    };
    for (const result of [full, project]) {
      expect(result).toMatchObject(expected);
      expect(result?.prs).toEqual(
        testCase.prs.flatMap((pr, index) =>
          pr.detachedAt
            ? []
            : [
                {
                  id: `${row.id}-${index}`,
                  completionDismissed: false,
                  revision: 0,
                  url: `https://github.com/org/repo/pull/${100 + index}`,
                  number: 100 + index,
                  title: `PR ${index}`,
                  headRefName: `feature-${index}`,
                  baseRefName: 'main',
                  state: pr.state,
                  reviewState: 'REVIEW_REQUIRED',
                  ciStatus: pr.ciStatus,
                  hasMergeConflict: pr.hasMergeConflict ?? false,
                  syncedAt: syncedAt.toISOString(),
                },
              ]
        )
      );
      expect(result).not.toHaveProperty('prDiscovery');
    }
    expect(full).toMatchObject({
      ratchetEnabled: testCase.enabled,
      ratchetState: testCase.ratchetState,
    });
    expect(project).not.toHaveProperty('ratchetState');
    expect(project).not.toHaveProperty('ratchetEnabled');
    expect(project).not.toHaveProperty('runScriptStatus');
    expect(project).not.toHaveProperty('prMonitoring');
  }
);

it('separates selected facts from collection facts and reselects after detach or recreation', async () => {
  const row = await workspace('selected-facts');
  await db.prisma.workspacePR.createMany({
    data: [
      {
        id: 'selected-a',
        workspaceId: row.id,
        url: 'https://github.com/org/repo/pull/101',
        number: 101,
        state: 'APPROVED',
        reviewState: 'APPROVED',
        ciStatus: 'SUCCESS',
      },
      {
        id: 'selected-b',
        workspaceId: row.id,
        url: 'https://github.com/org/repo/pull/102',
        number: 102,
        state: 'CHANGES_REQUESTED',
        reviewState: 'CHANGES_REQUESTED',
        ciStatus: 'FAILURE',
        hasMergeConflict: true,
      },
    ],
  });
  const expected = {
    selectedPrId: 'selected-a',
    selectedPr: {
      id: 'selected-a',
      number: 101,
      state: 'APPROVED',
      reviewState: 'APPROVED',
      ciStatus: 'SUCCESS',
      hasMergeConflict: false,
    },
    prSummary: { state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: true },
    prUrl: 'https://github.com/org/repo/pull/101',
    prNumber: 101,
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
  };
  expect(await workspaceAccessor.findById(row.id)).toMatchObject(expected);
  expect(await workspaceRatchetAccessor.findSnapshotProjection(row.id)).toMatchObject(expected);
  await workspacePrAccessor.detach({ workspaceId: row.id, prId: 'selected-a' });
  expect(await workspaceAccessor.findById(row.id)).toMatchObject({
    selectedPrId: 'selected-b',
    selectedPr: { number: 102 },
  });
  await db.prisma.workspacePR.delete({ where: { id: 'selected-a' } });
  const recreated = await workspacePrAccessor.attach(
    row.id,
    'https://github.com/org/repo/pull/101'
  );
  const current = await workspaceAccessor.findById(row.id);
  const firstId = [recreated.prId, 'selected-b'].sort()[0];
  expect(current).toMatchObject({ selectedPrId: firstId, selectedPr: { id: firstId } });
});
