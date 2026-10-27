import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PR_SNAPSHOT_UPDATED, prSnapshotService } from '@/backend/services/github';
import {
  workspaceDataService,
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PRObservation } from '@/shared/pr-monitoring';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';
import type { PRObservationPorts } from './pr-observation-ports';
import { observeMonitoredPR } from './pr-observation.orchestrator';

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
const fetchObservation = vi.fn<PRObservationPorts['fetchObservation']>();
const ports: PRObservationPorts = {
  cacheScope: {},
  findPR: (target) => workspacePrSnapshotService.find(target),
  getMonitoring: (id) => workspacePRMonitoringService.get(id),
  fetchObservation,
  acceptObservation: (input) => workspacePrSnapshotService.acceptMonitoredObservation(input),
  publishAcceptedObservation: (event) => {
    prSnapshotService.emit(PR_SNAPSHOT_UPDATED, event);
  },
};
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
    observe: (target, options) => observeMonitoredPR(ports, target, options),
    workspace: {
      listPRs: (id) => workspacePrSnapshotService.list(id),
      findPR: (target) => workspacePrSnapshotService.find(target),
      attachPR: (id, url) => workspacePrSnapshotService.attach(id, url),
      detachPR: (target) => workspacePrSnapshotService.detach(target),
      attachDiscoveredPRsIfClaimMatches: (id, claim, urls) =>
        workspacePrSnapshotService.attachDiscoveredPRsIfClaimMatches(id, claim, urls),
      findPRContext: (id) => workspaceDataService.findPRContext(id),
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('adds another PR without replacing its sibling or changing the workspace branch', async () => {
  fetchObservation.mockResolvedValue({
    ...redObservation,
    url: 'https://github.com/org/repo/pull/2',
    number: 2,
    ciStatus: 'PENDING',
    headBranch: 'other-branch',
    checks: [],
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

it('rejects a refresh started before detach and reattach', async () => {
  const attached = await workspacePrSnapshotService.attach(
    'multi',
    'https://github.com/other/repo/pull/8'
  );
  let resolve!: (value: PRObservation) => void;
  fetchObservation.mockImplementationOnce(
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
    ...redObservation,
    url: 'https://github.com/other/repo/pull/8',
    repository: 'other/repo',
    number: 8,
    prState: 'MERGED',
    ciStatus: 'SUCCESS',
    headBranch: 'old',
    checks: [],
  });
  expect(await refresh).toEqual({ success: false, reason: 'stale_observation' });
  expect(
    await workspacePrSnapshotService.find({ workspaceId: 'multi', prId: attached.prId })
  ).toMatchObject({ state: 'NONE' });
});

it('rejects a normalized observation with a mismatched URL without changing either sibling', async () => {
  const target = { workspaceId: 'multi', prId: 'pr-a' };
  const before = await workspacePrSnapshotService.list('multi');
  fetchObservation.mockResolvedValueOnce({
    ...redObservation,
    url: 'https://github.com/org/repo/pull/99',
    number: 99,
  });
  const published = vi.fn();
  prSnapshotService.on(PR_SNAPSHOT_UPDATED, published);
  try {
    expect(await prSnapshotService.refreshPR(target)).toEqual({
      success: false,
      reason: 'stale_observation',
    });
    expect(await workspacePrSnapshotService.list('multi')).toEqual(before);
    expect(published).not.toHaveBeenCalled();
  } finally {
    prSnapshotService.off(PR_SNAPSHOT_UPDATED, published);
  }
});
