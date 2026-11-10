import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { githubCLIService, prObservationService } from '@/backend/services/github';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';
import type { PRObservationPorts } from './pr-observation-ports';
import { observeMonitoredPR } from './pr-observation.orchestrator';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing test database');
    }
    return state.prisma;
  },
}));

let db: IntegrationDatabase;
let sequence = 0;
const readPolicy = vi.fn(async () => ({ reviewTriggerMode: 'CHANGES_REQUESTED' as const }));
const core = {
  number: 1,
  title: 'PR',
  url: redObservation.url,
  updatedAt: redObservation.observedAt,
  isDraft: false,
  state: 'OPEN' as const,
  reviewDecision: null,
  statusCheckRollup: [],
  headRefOid: 'head',
  headRefName: 'feature',
  baseRefName: 'main',
  mergeStateStatus: 'CLEAN' as const,
};
function comment(id: number) {
  return {
    id,
    author: { login: 'reviewer' },
    body: `Please fix ${id}`,
    path: 'src/file.ts',
    line: id,
    url: `${redObservation.url}#discussion_r${id}`,
    createdAt: redObservation.observedAt,
    updatedAt: redObservation.observedAt,
  };
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(() => {
  // Force the real observation service to retry identity for every independent case.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ++sequence * 300_001);
  readPolicy.mockReset().mockResolvedValue({ reviewTriggerMode: 'CHANGES_REQUESTED' });
  prObservationService.configure({
    findPR: (target) => workspacePrSnapshotService.find(target),
    readPolicy,
  });
  vi.spyOn(githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('me');
  vi.spyOn(githubCLIService, 'getPRStatusDetails').mockResolvedValue(core);
  vi.spyOn(githubCLIService, 'getPRReviewDetails').mockResolvedValue({
    updatedAt: core.updatedAt,
    reviews: [],
    comments: [],
  });
  vi.spyOn(githubCLIService, 'getReviewComments').mockResolvedValue([comment(1)]);
  vi.spyOn(githubCLIService, 'getResolvedReviewCommentIds').mockResolvedValue(new Set());
});

async function setup({ enabled = true }: { enabled?: boolean } = {}) {
  const workspaceId = `review-flow-${sequence}`;
  const prId = `${workspaceId}-pr`;
  const target = { workspaceId, prId };
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: 'Review flow',
      status: 'READY',
      prMonitoring: { create: { enabled, eventEpoch: 1 } },
      prs: { create: { id: prId, url: core.url } },
    },
  });
  const ports = {
    cacheScope: {},
    findPR: (input) => workspacePrSnapshotService.find(input),
    getMonitoring: (id) => workspacePRMonitoringService.get(id),
    fetchObservation: (input, signal, options) =>
      prObservationService.fetch(input, signal, options),
    acceptObservation: (input) => workspacePrSnapshotService.acceptMonitoredObservation(input),
    publishAcceptedObservation: vi.fn(),
  } satisfies PRObservationPorts;
  const observe = (signal?: AbortSignal) =>
    observeMonitoredPR(ports, target, { force: true, signal });
  return { target, ports, observe };
}

it.each(['username', 'policy', 'reviews', 'comments', 'resolved threads'])(
  'accepts CI through %s failure without resolving pending feedback, then accepts complete enrichment',
  async (failure) => {
    const { target, ports, observe } = await setup();
    expect(await observe()).toBe(true);
    const before = await workspacePRMonitoringService.listPending(target.workspaceId, target.prId);
    expect(before).toHaveLength(1);
    expect(before[0]?.kind).toBe('REVIEW_FEEDBACK');
    vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue({
      ...core,
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    });
    const unavailable = new Error('review unavailable');
    if (failure === 'username') {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001);
      vi.mocked(githubCLIService.getAuthenticatedUsername).mockResolvedValueOnce(null);
    } else if (failure === 'policy') {
      readPolicy.mockRejectedValueOnce(unavailable);
    } else if (failure === 'reviews') {
      vi.mocked(githubCLIService.getPRReviewDetails).mockRejectedValueOnce(unavailable);
    } else if (failure === 'comments') {
      vi.mocked(githubCLIService.getReviewComments).mockRejectedValueOnce(unavailable);
    } else {
      vi.mocked(githubCLIService.getResolvedReviewCommentIds).mockRejectedValueOnce(unavailable);
    }
    expect(await observe()).toBe(true);
    expect(await workspacePrSnapshotService.find(target)).toMatchObject({
      ciStatus: 'FAILURE',
      observation: {
        reviewsComplete: false,
        actionableReviews: [expect.objectContaining({ identity: 'comment:1' })],
      },
    });
    const pending = await workspacePRMonitoringService.listPending(target.workspaceId, target.prId);
    expect(pending.map((event) => event.kind).sort()).toEqual(['CI_FAILED', 'REVIEW_FEEDBACK']);
    expect(pending.find((event) => event.kind === 'REVIEW_FEEDBACK')?.id).toBe(before[0]?.id);
    vi.mocked(githubCLIService.getReviewComments).mockResolvedValue([]);
    expect(await observe()).toBe(true);
    expect(await workspacePrSnapshotService.find(target)).toMatchObject({
      observation: { reviewsComplete: true, actionableReviews: [] },
    });
    expect(
      (await workspacePRMonitoringService.listPending(target.workspaceId, target.prId)).map(
        (event) => event.kind
      )
    ).toEqual(['CI_FAILED']);
    expect(ports.publishAcceptedObservation).toHaveBeenCalledTimes(3);
  }
);

it('retains omitted feedback on a partial page while honoring only known resolved IDs', async () => {
  const { target, observe } = await setup();
  vi.mocked(githubCLIService.getReviewComments).mockResolvedValue([comment(1), comment(2)]);
  expect(await observe()).toBe(true);
  vi.mocked(githubCLIService.getReviewComments).mockImplementation(
    (_repo, _number, _since, _signal, incomplete) => {
      incomplete?.();
      return Promise.resolve([comment(2)]);
    }
  );
  vi.mocked(githubCLIService.getResolvedReviewCommentIds).mockResolvedValue(new Set([2]));
  expect(await observe()).toBe(true);
  expect(await workspacePrSnapshotService.find(target)).toMatchObject({
    observation: {
      reviewsComplete: false,
      resolvedReviewIds: ['comment:2'],
      actionableReviews: [expect.objectContaining({ identity: 'comment:1' })],
    },
  });
  expect(
    await workspacePRMonitoringService.listPending(target.workspaceId, target.prId)
  ).toHaveLength(1);
  vi.mocked(githubCLIService.getReviewComments).mockResolvedValue([]);
  expect(await observe()).toBe(true);
  expect(await workspacePRMonitoringService.listPending(target.workspaceId, target.prId)).toEqual(
    []
  );
});

it('still supersedes old heads and terminal facts while reviews are unavailable', async () => {
  const { target, observe } = await setup();
  expect(await observe()).toBe(true);
  readPolicy.mockRejectedValue(new Error('settings unavailable'));
  vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue({
    ...core,
    headRefOid: 'next-head',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  });
  expect(await observe()).toBe(true);
  expect(
    (await workspacePRMonitoringService.listPending(target.workspaceId, target.prId)).map(
      (event) => event.kind
    )
  ).toEqual(['CI_FAILED']);
  vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue({
    ...core,
    headRefOid: 'next-head',
    state: 'MERGED',
  });
  expect(await observe()).toBe(true);
  expect(
    (await workspacePRMonitoringService.listPending(target.workspaceId, target.prId)).map(
      (event) => event.kind
    )
  ).toEqual(['PR_MERGED']);
});

it.each(['core', 'abort'])('never accepts or publishes after a %s failure', async (failure) => {
  const { target, ports, observe } = await setup();
  const controller = new AbortController();
  const error = new Error('stopped');
  if (failure === 'core') {
    vi.mocked(githubCLIService.getPRStatusDetails).mockRejectedValue(error);
  } else {
    vi.mocked(githubCLIService.getReviewComments).mockImplementation(() => {
      controller.abort(error);
      return Promise.reject(error);
    });
  }
  await expect(observe(controller.signal)).rejects.toBe(error);
  expect(await workspacePrSnapshotService.find(target)).toMatchObject({ revision: 0 });
  expect(await workspacePRMonitoringService.listPending(target.workspaceId, target.prId)).toEqual(
    []
  );
  expect(ports.publishAcceptedObservation).not.toHaveBeenCalled();
});

function reviewReads() {
  return [
    githubCLIService.getPRReviewDetails,
    githubCLIService.getReviewComments,
    githubCLIService.getResolvedReviewCommentIds,
  ].reduce((total, read) => total + vi.mocked(read).mock.calls.length, 0);
}
async function setMonitoring(workspaceId: string, enabled: boolean) {
  const config = await workspacePRMonitoringService.get(workspaceId);
  const result = await workspacePRMonitoringService.setBinding({
    workspaceId,
    enabled,
    expectedBindingRevision: config?.bindingRevision ?? 0,
  });
  expect(result.applied).toBe(true);
}

it('reads only core facts while monitoring is off and baselines reviews when it turns on', async () => {
  const { target, ports } = await setup({ enabled: false });
  const poll = () => observeMonitoredPR(ports, target);
  expect(await poll()).toBe(true);
  expect(reviewReads()).toBe(0);
  expect(await workspacePrSnapshotService.find(target)).toMatchObject({
    state: 'OPEN',
    observation: { reviewsComplete: false, actionableReviews: [] },
  });
  expect(await workspacePRMonitoringService.listPending(target.workspaceId)).toEqual([]);

  // Enabling renews the epoch, so the next automatic poll reads reviews without
  // waiting for the recent-observation window.
  await setMonitoring(target.workspaceId, true);
  expect(await poll()).toBe(true);
  expect(reviewReads()).toBe(3);
  const pending = await workspacePRMonitoringService.listPending(target.workspaceId);
  expect(pending.map((event) => event.kind)).toEqual(['REVIEW_FEEDBACK']);

  // The full observation is the new baseline: unchanged feedback is not repeated.
  expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
  expect(
    (await workspacePRMonitoringService.listPending(target.workspaceId)).map((event) => event.id)
  ).toEqual(pending.map((event) => event.id));

  // Turning monitoring off again stops review reads.
  await setMonitoring(target.workspaceId, false);
  expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
  expect(reviewReads()).toBe(6);
});

it('rejects a core-only observation when monitoring turns on before it is accepted', async () => {
  const { target, ports } = await setup({ enabled: false });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(githubCLIService.getPRStatusDetails).mockImplementationOnce(async () => {
    await released;
    return core;
  });
  const observing = observeMonitoredPR(ports, target, { force: true });
  await vi.waitFor(() => expect(githubCLIService.getPRStatusDetails).toHaveBeenCalledOnce());
  await setMonitoring(target.workspaceId, true);
  release();
  expect(await observing).toBe(false);
  expect(reviewReads()).toBe(0);
  expect(await workspacePrSnapshotService.find(target)).toMatchObject({ revision: 0 });

  expect(await observeMonitoredPR(ports, target)).toBe(true);
  expect(reviewReads()).toBe(3);
  expect(
    (await workspacePRMonitoringService.listPending(target.workspaceId)).map((event) => event.kind)
  ).toEqual(['REVIEW_FEEDBACK']);
});
