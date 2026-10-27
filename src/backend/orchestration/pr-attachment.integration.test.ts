import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PR_SNAPSHOT_UPDATED, PR_URL_ATTACHED, prSnapshotService } from '@/backend/services/github';
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
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { PrismaClient } from '@prisma-gen/client';
import {
  createEventCollectorOrchestrator,
  type EventCollectorDependencies,
} from './event-collector.orchestrator';
import type { PRObservationPorts } from './pr-observation-ports';
import { observeMonitoredPR } from './pr-observation.orchestrator';
import { fireLifecycleNotification } from './workspace-children.orchestrator';

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
const fetchObservation = vi.fn<PRObservationPorts['fetchObservation']>();
const previousPrUrl = 'https://github.com/org/repo/pull/1';
const nextPrUrl = 'https://github.com/org/repo/pull/2';
function facts(url: string, overrides: Partial<PRObservation> = {}): PRObservation {
  return { ...redObservation, url, number: Number(url.split('/').at(-1)), ...overrides };
}
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
  testDatabase.prisma = db.prisma;
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
  await db.prisma.project.create({
    data: {
      id: 'pr-project',
      name: 'PR project',
      slug: 'pr-project',
      repoPath: '/tmp/pr-project',
      worktreeBasePath: '/tmp/pr-project-worktrees',
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
}, 30_000);
beforeEach(() => {
  fetchObservation.mockReset();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

describe('normalized PR attachment recovery', () => {
  it.each(['OPEN', 'MERGED', 'CLOSED'] as const)(
    'preserves a previous %s PR and isolates normalized observations for a newly attached URL',
    async (previousState) => {
      const workspaceId = `pr-${previousState}`;
      await db.prisma.workspace.create({
        data: {
          id: workspaceId,
          name: workspaceId,
          projectId: 'pr-project',
          status: 'READY',
          branchName: 'workspace-branch',
          prs: {
            create: {
              id: `old-${previousState}`,
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
      fetchObservation.mockRejectedValueOnce(new Error('GitHub unavailable'));
      const attached = await prSnapshotService.attachAndRefreshPR(workspaceId, nextPrUrl);
      expect(attached).toEqual({ success: false, reason: 'error', prId: expect.any(String) });
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
        observation: null,
      });
      expect(await db.prisma.workspacePREvent.count({ where: { prId: neutralCache.id } })).toBe(0);

      // A late observation for the old association cannot overwrite its new sibling.
      fetchObservation.mockResolvedValueOnce(
        facts(previousPrUrl, {
          prState: 'MERGED',
          ciStatus: 'SUCCESS',
          reviewState: 'APPROVED',
          checks: [],
        })
      );
      expect(
        await prSnapshotService.refreshPR({ workspaceId, prId: `old-${previousState}` })
      ).toMatchObject({ success: true });
      expect(
        await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: neutralCache.id } })
      ).toEqual(neutralCache);
      const previousAfterObservation = await db.prisma.workspacePR.findUniqueOrThrow({
        where: { id: `old-${previousState}` },
      });
      const next = facts(nextPrUrl, { ciStatus: 'PENDING', hasMergeConflict: true, checks: [] });
      fetchObservation.mockResolvedValueOnce(next);
      expect(
        await prSnapshotService.refreshPR({ workspaceId, prId: neutralCache.id })
      ).toMatchObject({ success: true });
      expect(
        await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: neutralCache.id } })
      ).toMatchObject({
        url: nextPrUrl,
        state: 'OPEN',
        reviewState: null,
        ciStatus: 'PENDING',
        hasMergeConflict: true,
        revision: 1,
        observation: next,
      });
      expect(
        await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: `old-${previousState}` } })
      ).toEqual(previousAfterObservation);
      expect(
        await workspacePRMonitoringService.listPending(workspaceId, neutralCache.id)
      ).toMatchObject([
        { kind: 'CONFLICT_DETECTED', payload: { target: { workspaceId, prId: neutralCache.id } } },
      ]);
      expect(
        await db.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
      ).toMatchObject({ branchName: 'workspace-branch' });
    }
  );
});

it('keeps discovery tombstones and only explicit attachment reactivates and observes them', async () => {
  const workspaceId = 'tombstones';
  const checkedAt = new Date('2026-01-01T00:00:00Z');
  const nextCheckAt = new Date('2026-01-01T00:01:00Z');
  const claim = {
    githubOwner: 'org',
    githubRepo: 'repo',
    branchName: 'feature',
    checkedAt,
    nextCheckAt,
    retryCount: 1,
  };
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      name: workspaceId,
      projectId: 'pr-project',
      status: 'READY',
      branchName: 'feature',
      prMonitoring: { create: { enabled: true } },
      prDiscovery: { create: { lastCheckedAt: checkedAt, nextCheckAt, retryCount: 1 } },
      prs: { create: { id: 'tombstone', url: previousPrUrl, detachedAt: checkedAt, revision: 4 } },
    },
  });
  const tombstone = await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: 'tombstone' } });
  fetchObservation.mockResolvedValue(facts(nextPrUrl));
  const attachedEvents = vi.fn();
  prSnapshotService.on(PR_URL_ATTACHED, attachedEvents);
  try {
    expect(
      await prSnapshotService.attachDiscoveredPRsAndRefresh(
        workspaceId,
        [previousPrUrl, nextPrUrl, nextPrUrl],
        claim
      )
    ).toBe(1);
    const active = await workspacePrSnapshotService.list(workspaceId);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      url: nextPrUrl,
      state: 'OPEN',
      observation: facts(nextPrUrl),
    });
    expect(await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: 'tombstone' } })).toEqual(
      tombstone
    );
    expect(fetchObservation).toHaveBeenCalledTimes(1);
    expect(attachedEvents).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      prId: active[0]!.id,
      prUrl: nextPrUrl,
    });
    expect(
      await prSnapshotService.attachDiscoveredPRsAndRefresh(
        workspaceId,
        [previousPrUrl, nextPrUrl],
        claim
      )
    ).toBe(0);
    expect(fetchObservation).toHaveBeenCalledTimes(1);
    expect(
      await workspacePRMonitoringService.listPending(workspaceId, active[0]!.id)
    ).toMatchObject([{ kind: 'CI_FAILED' }]);
    fetchObservation.mockResolvedValueOnce(facts(previousPrUrl));
    expect(await prSnapshotService.attachAndRefreshPR(workspaceId, previousPrUrl)).toMatchObject({
      success: true,
      prId: 'tombstone',
    });
    expect(await workspacePrSnapshotService.find({ workspaceId, prId: 'tombstone' })).toMatchObject(
      { detachedAt: null, state: 'OPEN', observation: facts(previousPrUrl) }
    );
    expect(await workspacePrSnapshotService.list(workspaceId)).toHaveLength(2);
  } finally {
    prSnapshotService.off(PR_URL_ATTACHED, attachedEvents);
  }
});

it('persists one parent notification per accepted NONE-to-OPEN association and none for stale writes', async () => {
  await db.prisma.workspace.create({
    data: { id: 'parent', name: 'Parent', projectId: 'pr-project', status: 'READY' },
  });
  const workspaceId = 'child';
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      name: 'Child',
      projectId: 'pr-project',
      status: 'READY',
      parentWorkspaceId: 'parent',
      prMonitoring: { create: { enabled: true } },
    },
  });
  const notifyParent = vi.fn(fireLifecycleNotification);
  const collector = createEventCollectorOrchestrator(
    unsafeCoerce<EventCollectorDependencies>({
      createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      fireLifecycleNotification: notifyParent,
      prSnapshotService,
      workspaceActivityService: new EventEmitter(),
      workspaceStateMachine: new EventEmitter(),
      ratchetService: new EventEmitter(),
      runScriptStateMachine: new EventEmitter(),
      workspaceAutoIterationService: new EventEmitter(),
      sessionDomainService: new EventEmitter(),
      workspaceDataService: { findRatchetProjection: vi.fn().mockResolvedValue(null) },
      workspaceSnapshotStore: { getAllWorkspaceIds: () => [], upsert: vi.fn() },
    })
  );
  collector.start();
  try {
    fetchObservation.mockResolvedValueOnce(facts(previousPrUrl));
    const first = await prSnapshotService.attachAndRefreshPR(workspaceId, previousPrUrl);
    expect(first.success).toBe(true);
    await vi.waitFor(async () =>
      expect(
        await db.prisma.workspaceNotification.count({ where: { workspaceId: 'parent' } })
      ).toBe(1)
    );
    const firstPR = await db.prisma.workspacePR.findUniqueOrThrow({
      where: { workspaceId_url: { workspaceId, url: previousPrUrl } },
    });
    fetchObservation.mockResolvedValueOnce(facts(previousPrUrl));
    await prSnapshotService.refreshPR({ workspaceId, prId: firstPR.id });
    fetchObservation.mockResolvedValueOnce(facts(nextPrUrl));
    expect((await prSnapshotService.attachAndRefreshPR(workspaceId, nextPrUrl)).success).toBe(true);
    await vi.waitFor(async () =>
      expect(
        await db.prisma.workspaceNotification.count({ where: { workspaceId: 'parent' } })
      ).toBe(2)
    );
    const thirdUrl = 'https://github.com/org/repo/pull/3';
    const third = await workspacePrSnapshotService.attach(workspaceId, thirdUrl);
    fetchObservation.mockImplementationOnce(async () => {
      await db.prisma.workspacePRMonitoring.update({
        where: { workspaceId },
        data: { eventEpoch: { increment: 1 } },
      });
      return facts(thirdUrl);
    });
    expect(await prSnapshotService.refreshPR({ workspaceId, prId: third.prId })).toEqual({
      success: false,
      reason: 'stale_observation',
    });
    expect(await workspacePrSnapshotService.find({ workspaceId, prId: third.prId })).toMatchObject({
      state: 'NONE',
      observation: null,
    });
    expect(notifyParent).toHaveBeenCalledTimes(2);
    await Promise.all(notifyParent.mock.results.map((result) => result.value));
    const notifications = await db.prisma.workspaceNotification.findMany({
      where: { workspaceId: 'parent' },
    });
    expect(notifications).toHaveLength(2);
    for (const notification of notifications) {
      expect(notification).toMatchObject({
        sourceWorkspaceId: workspaceId,
        message: 'A pull request has been opened.',
      });
    }
  } finally {
    collector.stop();
  }
});
