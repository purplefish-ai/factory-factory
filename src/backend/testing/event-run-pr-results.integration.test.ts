import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createEventDeliveryFixture,
  releaseEventBoundaries,
  drainEventFixtureTasks,
  boundary,
  deferred,
} from '@/backend/orchestration/testing/event-delivery.test-support';
import { fakeEventProvider } from '@/backend/orchestration/testing/event-provider.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
let provider: ReturnType<typeof fakeEventProvider>;
let pending: Promise<unknown>[];
let committedAttachments: string[];
beforeEach(async () => {
  pending = [];
  committedAttachments = [];
  db = await createIntegrationDatabase();
  h = await createEventDeliveryFixture(db);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('No host signals');
  });
  const factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  const { AcpNativeSessionTracker } = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-native-session-tracker')
  >('@/backend/services/session/service/acp/acp-native-session-tracker');
  vi.spyOn(factory.AcpClientFactory.prototype, 'createClient').mockImplementation(({ options }) => {
    provider = fakeEventProvider(
      h.session.AcpProcessHandle,
      options,
      undefined,
      new AcpNativeSessionTracker()
    );
    return Promise.resolve(provider.handle);
  });
}, 30_000);
afterEach(async () => {
  releaseEventBoundaries();
  await Promise.allSettled(pending);
  provider?.response.resolve({ stopReason: 'end_turn' });
  await drainEventFixtureTasks();
  await h.session.acpRuntimeManager.stopAllClients(10).catch(() => undefined);
  h.session.sessionPromptTurnCompletionService.clearAll();
  h.session.sessionDomainService.clearAllSessions();
  expect(process.kill).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await destroyIntegrationDatabase(db);
  provider = undefined!;
});
const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
async function finish(outcome: 'COMPLETED' | 'FAILED' | 'CANCELLED' = 'COMPLETED') {
  const dispatch = h.dispatch();
  await vi.waitFor(() => expect(provider).toBeDefined());
  await provider.called;
  provider.response.resolve(
    outcome === 'FAILED'
      ? {
          stopReason: 'end_turn',
          _meta: {
            jetbrains: { air: { sessionFailure: { severity: 'error', title: 'Provider failed' } } },
          },
        }
      : { stopReason: outcome === 'CANCELLED' ? 'cancelled' : 'end_turn' }
  );
  if (outcome === 'FAILED') {
    await expect(dispatch).rejects.toThrow('Provider failed');
  } else {
    await dispatch;
  }
}

it.each(['RUNNING', 'COMPLETED'] as const)(
  'captures an unobserved unhydrated PR before deleting a %s workspace',
  async (status) => {
    await finish();
    if (status === 'COMPLETED') {
      const { observeEventRun } = await vi.importActual<
        typeof import('@/backend/orchestration/event-run-monitor.orchestrator')
      >('@/backend/orchestration/event-run-monitor.orchestrator');
      expect(await observeEventRun(h.claim)).toBe('SETTLED');
    }
    await db.prisma.agentRun.update({
      where: { id: h.claim.runId },
      data: { result: { version: 1, summary: 'Keep this summary', pullRequests: [] } },
    });
    const before = await row();
    const evidence = await h.read();
    await h.workspace.workspacePrSnapshotService.attach(
      h.claim.reservedWorkspaceId,
      'https://github.com/org/repo/pull/42'
    );
    await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
    expect(await row()).toEqual({
      ...before,
      workspaceId: null,
      result: {
        version: 1,
        summary: 'Keep this summary',
        pullRequests: [{ url: 'https://github.com/org/repo/pull/42', number: 42 }],
      },
    });
    expect(await h.read()).toEqual(evidence);
    expect(await db.prisma.workspacePR.count()).toBe(0);
    expect(await db.prisma.workspace.count()).toBe(0);
  }
);

it('retains an unhydrated uppercase PR path attached before deletion', async () => {
  const workspaceId = h.claim.reservedWorkspaceId;
  const { prId } = await h.workspace.workspacePrSnapshotService.attach(
    workspaceId,
    'https://github.com/Org/Repo/PULL/42'
  );
  expect(await h.workspace.workspacePrSnapshotService.find({ workspaceId, prId })).toMatchObject({
    number: null,
  });
  const before = await row();
  await h.workspace.workspaceDataService.delete(workspaceId);
  expect(await row()).toEqual({
    ...before,
    workspaceId: null,
    result: {
      version: 1,
      summary: '',
      pullRequests: [{ url: 'https://github.com/Org/Repo/PULL/42', number: 42 }],
    },
  });
  expect(await db.prisma.workspacePR.count()).toBe(0);
});

async function attachment(path: 'manual' | 'discovery' | 'agent') {
  const { prSnapshotService, PR_URL_ATTACHED } = await vi.importActual<
    typeof import('@/backend/services/github')
  >('@/backend/services/github');
  prSnapshotService.on(PR_URL_ATTACHED, ({ prUrl }: { prUrl: string }) =>
    committedAttachments.push(prUrl)
  );
  const workspace = h.workspace.workspacePrSnapshotService;
  prSnapshotService.configure({
    workspace: {
      listPRs: (id) => workspace.list(id),
      findPR: (target) => workspace.find(target),
      attachPR: (id, url) => workspace.attach(id, url),
      detachPR: (target) => workspace.detach(target),
      findPRContext: (id) => h.workspace.workspaceDataService.findPRContext(id),
      attachDiscoveredPRsIfClaimMatches: (id, claim, urls) =>
        workspace.attachDiscoveredPRsIfClaimMatches(id, claim, urls),
    },
    // Only provider observation is fake; attachment, claims and database commits are real.
    observe: async () => false,
  });
  const id = h.claim.reservedWorkspaceId;
  const url = 'https://github.com/org/repo/pull/42';
  if (path === 'manual') {
    return () => prSnapshotService.attachAndRefreshPR(id, url);
  }
  if (path === 'agent') {
    const { prDetectionInterceptor } = await vi.importActual<
      typeof import('@/backend/interceptors/pr-detection.interceptor')
    >('@/backend/interceptors/pr-detection.interceptor');
    return () =>
      prDetectionInterceptor.onToolComplete!(
        {
          toolUseId: 'create-pr',
          toolName: 'Bash',
          input: { command: 'gh pr create --fill' },
          output: { content: url, isError: false },
        },
        {
          workspaceId: id,
          sessionId: h.attempt.sessionId,
          subagentId: 'native-child',
          workingDir: db.tempDir,
          timestamp: new Date(),
        }
      );
  }
  const current = await h.workspace.workspaceDataService.findById(id);
  const checkedAt = new Date();
  const nextCheckAt = new Date(checkedAt.getTime() + 60_000);
  expect(
    await h.workspace.workspaceMaintenanceService.claimPRDiscoveryAttempt(id, {
      branchName: 'fixture',
      expectedUpdatedAt: current!.updatedAt,
      expectedRetryCount: 0,
      expectedNextCheckAt: null,
      checkedAt,
      nextCheckAt,
    })
  ).toBe(true);
  return () =>
    prSnapshotService.attachDiscoveredPRsAndRefresh(id, [url], {
      branchName: 'fixture',
      githubOwner: 'org',
      githubRepo: 'repo',
      checkedAt,
      retryCount: 1,
      nextCheckAt,
    });
}

const raceCases = (['manual', 'discovery', 'agent'] as const).flatMap((path) =>
  (['RUNNING', 'COMPLETED'] as const).map((status) => ({ path, status }))
);
async function settleForRace(status: 'RUNNING' | 'COMPLETED') {
  if (status === 'COMPLETED') {
    await finish();
    const { observeEventRun } = await vi.importActual<
      typeof import('@/backend/orchestration/event-run-monitor.orchestrator')
    >('@/backend/orchestration/event-run-monitor.orchestrator');
    expect(await observeEventRun(h.claim)).toBe('SETTLED');
  }
}

it.each(raceCases)(
  'retains the $path attachment committed before final capture for $status',
  async ({ path, status }) => {
    await settleForRace(status);
    const attach = await attachment(path);
    const transaction = db.prisma.$transaction.bind(db.prisma);
    const gate = boundary();
    vi.spyOn(db.prisma, '$transaction').mockImplementationOnce((operation) =>
      transaction(async (tx) => {
        const result = await operation(tx);
        await gate.wait();
        return result;
      })
    );
    const attaching = attach();
    pending.push(attaching);
    await gate.entered;
    const attempted = deferred<void>();
    vi.spyOn(db.prisma, '$transaction').mockImplementationOnce((operation) => {
      attempted.resolve();
      return transaction(operation);
    });
    let deleted = false;
    const deleting = h.workspace.workspaceDataService
      .delete(h.claim.reservedWorkspaceId)
      .then(() => {
        deleted = true;
      });
    void deleting.catch(() => undefined);
    pending.push(deleting);
    await attempted.promise;
    expect(deleted).toBe(false);
    gate.release();
    await Promise.all([attaching, deleting]);
    expect(committedAttachments).toEqual(['https://github.com/org/repo/pull/42']);
    expect(await row()).toMatchObject({
      status,
      result: { pullRequests: [{ url: 'https://github.com/org/repo/pull/42', number: 42 }] },
    });
    expect(await db.prisma.workspacePR.count()).toBe(0);
  }
);

it.each(raceCases)(
  'prevents $path attachment from committing between final capture and deletion for $status',
  async ({ path, status }) => {
    await settleForRace(status);
    const attach = await attachment(path);
    await h.workspace.workspacePrSnapshotService.attach(
      h.claim.reservedWorkspaceId,
      'https://github.com/org/repo/pull/41'
    );
    const transaction = db.prisma.$transaction.bind(db.prisma);
    const gate = boundary();
    const capture = h.owner.eventRunResults.captureWorkspace.bind(h.owner.eventRunResults);
    vi.spyOn(h.owner.eventRunResults, 'captureWorkspace').mockImplementationOnce(
      async (...args) => {
        await capture(...args);
        await gate.wait();
      }
    );
    const deleting = h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
    pending.push(deleting);
    await gate.entered;
    const attempted = deferred<void>();
    vi.spyOn(db.prisma, '$transaction').mockImplementationOnce((operation) => {
      attempted.resolve();
      return transaction(operation);
    });
    let attached = false;
    const attaching = attach().then((result) => {
      attached = true;
      return result;
    });
    void attaching.catch(() => undefined);
    pending.push(attaching);
    await attempted.promise;
    expect(attached).toBe(false);
    gate.release();
    await deleting;
    const result = await attaching;
    expect(committedAttachments).toEqual([]);
    if (path === 'manual') {
      expect(result).toMatchObject({ success: false });
      expect(result).not.toHaveProperty('prId');
    }
    if (path === 'discovery') {
      expect(result).toBe(0);
    }
    expect(await row()).toMatchObject({
      status,
      result: { pullRequests: [{ url: 'https://github.com/org/repo/pull/41', number: 41 }] },
    });
    expect(await db.prisma.workspacePR.count()).toBe(0);
    await expect(
      h.workspace.workspacePrSnapshotService.attach(
        h.claim.reservedWorkspaceId,
        'https://github.com/org/repo/pull/43'
      )
    ).rejects.toThrow();
  }
);

it.each(['capture', 'cascade'] as const)(
  'rolls back the %s failure with every owner fact intact',
  async (failure) => {
    await h.workspace.workspacePrSnapshotService.attach(
      h.claim.reservedWorkspaceId,
      'https://github.com/org/repo/pull/42'
    );
    const before = await row();
    const delivery = await h.read();
    const transaction = db.prisma.$transaction.bind(db.prisma);
    vi.spyOn(db.prisma, '$transaction').mockImplementationOnce((operation) =>
      transaction((tx) => {
        if (failure === 'capture') {
          vi.spyOn(tx.agentRun, 'updateMany').mockRejectedValueOnce(new Error('capture failed'));
        } else {
          vi.spyOn(tx.workspace, 'delete').mockRejectedValueOnce(new Error('cascade failed'));
        }
        return operation(tx);
      })
    );
    await expect(
      h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId)
    ).rejects.toThrow(`${failure} failed`);
    expect(await row()).toEqual(before);
    expect(await h.read()).toEqual(delivery);
    expect(await h.workspace.workspaceDataService.exists(h.claim.reservedWorkspaceId)).toBe(true);
    expect(
      await h.workspace.workspacePrSnapshotService.list(h.claim.reservedWorkspaceId)
    ).toHaveLength(1);
    expect(await db.prisma.agentSession.count()).toBe(1);
  }
);

it('captures unseen detached, case-equivalent and multiple PRs while preserving the retained union', async () => {
  const workspaceId = h.claim.reservedWorkspaceId;
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: {
      result: {
        version: 1,
        summary: 'Earlier generation',
        pullRequests: [{ url: 'https://github.com/org/repo/pull/40', number: 40 }],
      },
    },
  });
  const detached = await h.workspace.workspacePrSnapshotService.attach(
    workspaceId,
    'https://github.com/org/repo/pull/42'
  );
  await h.workspace.workspacePrSnapshotService.detach({ workspaceId, prId: detached.prId });
  await h.workspace.workspacePrSnapshotService.attach(
    workspaceId,
    'https://github.com/Org/Repo/pull/40'
  );
  await h.workspace.workspacePrSnapshotService.attach(
    workspaceId,
    'https://github.com/other/repo/pull/42'
  );
  await h.workspace.workspaceDataService.delete(workspaceId);
  const result = h.owner.agentRunResultSchema.parse((await row()).result);
  expect(result.summary).toBe('Earlier generation');
  expect(result.pullRequests).toHaveLength(3);
  expect(result.pullRequests).toEqual(
    expect.arrayContaining([
      { url: 'https://github.com/Org/Repo/pull/40', number: 40 },
      { url: 'https://github.com/org/repo/pull/42', number: 42 },
      { url: 'https://github.com/other/repo/pull/42', number: 42 },
    ])
  );
  const monitor = new h.owner.AgentRunMonitorService();
  expect(
    await monitor.observeRun(
      h.claim,
      h.attempt,
      { version: 1, summary: '', pullRequests: [] },
      null,
      () => undefined
    )
  ).toBe('HELD');
  expect(h.owner.agentRunResultSchema.parse((await row()).result)).toEqual(result);
});

it('keeps the existing twenty-result bound and earlier retained links', async () => {
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: {
      result: {
        version: 1,
        summary: '',
        pullRequests: [{ url: 'https://github.com/old/repo/pull/1', number: 1 }],
      },
    },
  });
  for (let number = 1; number <= 25; number++) {
    await h.workspace.workspacePrSnapshotService.attach(
      h.claim.reservedWorkspaceId,
      `https://github.com/org/repo/pull/${number}`
    );
  }
  await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
  const result = h.owner.agentRunResultSchema.parse((await row()).result);
  expect(result.pullRequests).toHaveLength(20);
  expect(result.pullRequests[0]).toEqual({ url: 'https://github.com/old/repo/pull/1', number: 1 });
  expect(new Set(result.pullRequests.map((pr) => pr.url)).size).toBe(20);
});

it('deduplicates retained legacy casing variants before applying the compact result bound', async () => {
  await db.prisma.workspacePR.createMany({
    data: [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `legacy-${String(index).padStart(2, '0')}`,
        workspaceId: h.claim.reservedWorkspaceId,
        url: `https://github.com/${[...'organization'].map((letter, bit) => (index & (1 << bit) ? letter.toUpperCase() : letter)).join('')}/repo/pull/42`,
      })),
      {
        id: 'new-pr',
        workspaceId: h.claim.reservedWorkspaceId,
        url: 'https://github.com/other/repo/pull/43',
      },
    ],
  });
  await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
  const result = h.owner.agentRunResultSchema.parse((await row()).result);
  expect(result.pullRequests).toHaveLength(2);
  expect(result.pullRequests).toContainEqual({
    url: 'https://github.com/other/repo/pull/43',
    number: 43,
  });
});

it.each([
  'project',
  'reserved',
  'linked',
  'origin',
  'origin-project',
  'origin-workspace',
  'result',
  'generation',
] as const)('fails closed on inconsistent %s facts before deletion', async (mismatch) => {
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: {
      result: {
        version: 1,
        summary: 'Keep prior results',
        pullRequests: [{ url: 'https://github.com/org/repo/pull/40', number: 40 }],
      },
    },
  });
  await h.workspace.workspacePrSnapshotService.attach(
    h.claim.reservedWorkspaceId,
    'https://github.com/org/repo/pull/42'
  );
  if (mismatch === 'project') {
    const project = await db.prisma.project.create({
      data: { name: 'Other', slug: 'other', repoPath: db.tempDir, worktreeBasePath: db.tempDir },
    });
    await db.prisma.workspace.update({
      where: { id: h.claim.reservedWorkspaceId },
      data: { projectId: project.id },
    });
  }
  if (mismatch === 'reserved') {
    await db.prisma.agentRun.update({
      where: { id: h.claim.runId },
      data: { reservedWorkspaceId: 'wrong' },
    });
  }
  if (mismatch === 'linked') {
    const other = await h.creation.create({
      type: 'MANUAL',
      projectId: h.workspaceSource.projectId,
      name: 'Other',
    });
    await db.prisma.agentRun.update({
      where: { id: h.claim.runId },
      data: { workspaceId: other.id },
    });
  }
  if (mismatch === 'origin') {
    await db.prisma.workspaceLaunchOrigin.update({
      where: { runId: h.claim.runId },
      data: { runId: 'wrong' },
    });
  }
  if (mismatch === 'origin-project') {
    const project = await db.prisma.project.create({
      data: {
        name: 'Other origin project',
        slug: 'other-origin',
        repoPath: db.tempDir,
        worktreeBasePath: db.tempDir,
      },
    });
    await db.prisma.workspaceLaunchOrigin.update({
      where: { runId: h.claim.runId },
      data: { projectId: project.id },
    });
  }
  if (mismatch === 'origin-workspace') {
    await db.prisma.workspaceLaunchOrigin.update({
      where: { runId: h.claim.runId },
      data: { workspaceId: 'moved-origin' },
    });
  }
  if (mismatch === 'result') {
    await db.prisma.agentRun.update({
      where: { id: h.claim.runId },
      data: { result: { version: 1, summary: 'Malformed' } },
    });
  }
  if (mismatch === 'generation') {
    await db.prisma.agentInitialDelivery.update({
      where: { runId: h.claim.runId },
      data: { attemptGeneration: 2 },
    });
  }
  const before = await row();
  const workspaceBefore = await db.prisma.workspace.findUniqueOrThrow({
    where: { id: h.claim.reservedWorkspaceId },
  });
  const prsBefore = await db.prisma.workspacePR.findMany({
    where: { workspaceId: h.claim.reservedWorkspaceId },
  });
  await expect(
    h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId)
  ).rejects.toThrow();
  expect(await row()).toEqual(before);
  expect(
    await db.prisma.workspace.findUnique({ where: { id: h.claim.reservedWorkspaceId } })
  ).toEqual(workspaceBefore);
  expect(
    await db.prisma.workspacePR.findMany({ where: { workspaceId: h.claim.reservedWorkspaceId } })
  ).toEqual(prsBefore);
});

it('captures by the reserved identity before linkage and preserves retained child origins', async () => {
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: { workspaceId: null, leaseExpiresAt: new Date(0) },
  });
  const child = await h.creation.create({
    type: 'CHILD_WORKSPACE',
    projectId: h.workspaceSource.projectId,
    parentWorkspaceId: h.claim.reservedWorkspaceId,
    name: 'Child',
  });
  await h.workspace.workspacePrSnapshotService.attach(
    h.claim.reservedWorkspaceId,
    'https://github.com/org/repo/pull/42'
  );
  const before = await row();
  const origins = await db.prisma.workspaceChildOrigin.findMany();
  await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
  expect(await row()).toMatchObject({
    ...before,
    result: {
      version: 1,
      summary: '',
      pullRequests: [{ url: 'https://github.com/org/repo/pull/42', number: 42 }],
    },
  });
  expect(await db.prisma.workspaceChildOrigin.findMany()).toEqual(origins);
  expect(await db.prisma.workspaceLaunchOrigin.count()).toBe(1);
  expect(await h.workspace.workspaceDataService.exists(child.id)).toBe(true);
  expect(await db.prisma.agentSession.count()).toBe(0);
  const pragmas = await db.prisma.$queryRaw<{ foreign_keys: bigint }[]>`PRAGMA foreign_keys`;
  expect(Number(pragmas[0]!.foreign_keys)).toBe(1);
});

it('deletes an ordinary workspace with no run through the same required capture port', async () => {
  const ordinary = await h.creation.create({
    type: 'MANUAL',
    projectId: h.workspaceSource.projectId,
    name: 'Ordinary',
  });
  const before = await row();
  await h.workspace.workspaceDataService.delete(ordinary.id);
  expect(await h.workspace.workspaceDataService.exists(ordinary.id)).toBe(false);
  expect(await row()).toEqual(before);
});

it('allows deletion after the corresponding run was deleted while retaining its origin', async () => {
  await h.workspace.workspacePrSnapshotService.attach(
    h.claim.reservedWorkspaceId,
    'https://github.com/org/repo/pull/42'
  );
  await db.prisma.$transaction(async (tx) => {
    await tx.agentEvaluation.updateMany({ where: { runId: h.claim.runId }, data: { runId: null } });
    await tx.agentRun.delete({ where: { id: h.claim.runId } });
  });
  const origin = await db.prisma.workspaceLaunchOrigin.findUniqueOrThrow({
    where: { runId: h.claim.runId },
  });
  await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
  expect(await db.prisma.agentRun.count()).toBe(0);
  expect(await db.prisma.workspace.count()).toBe(0);
  expect(await db.prisma.workspacePR.count()).toBe(0);
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: h.claim.runId } })
  ).toEqual(origin);
});

it('captures valid retained identity with unknown historical child coverage without resolving work', async () => {
  const origin = await db.prisma.workspaceLaunchOrigin.update({
    where: { runId: h.claim.runId },
    data: { childHistoryVersion: null },
  });
  await h.workspace.workspacePrSnapshotService.attach(
    h.claim.reservedWorkspaceId,
    'https://github.com/org/repo/pull/42'
  );
  const before = await row();
  await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
  expect(await row()).toEqual({
    ...before,
    workspaceId: null,
    result: {
      version: 1,
      summary: '',
      pullRequests: [{ url: 'https://github.com/org/repo/pull/42', number: 42 }],
    },
  });
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: h.claim.runId } })
  ).toEqual(origin);
});

it.each(['FAILED', 'CANCELLED', 'PR_CREATED'] as const)(
  'adds final results to %s without rewriting the settled outcome or timestamps',
  async (status) => {
    if (status === 'PR_CREATED') {
      await h.workspace.workspacePrSnapshotService.attach(
        h.claim.reservedWorkspaceId,
        'https://github.com/org/repo/pull/41'
      );
    } else {
      const groups = await vi.importActual<
        typeof import('@/backend/services/session/service/acp/acp-owned-group')
      >('@/backend/services/session/service/acp/acp-owned-group');
      vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
    }
    await finish(status === 'PR_CREATED' ? 'COMPLETED' : status);
    const { observeEventRun } = await vi.importActual<
      typeof import('@/backend/orchestration/event-run-monitor.orchestrator')
    >('@/backend/orchestration/event-run-monitor.orchestrator');
    expect(await observeEventRun(h.claim)).toBe('SETTLED');
    const before = await row();
    expect(before.status).toBe(status);
    expect(before.leaseExpiresAt).toBeNull();
    const evidence = await h.read();
    await h.workspace.workspacePrSnapshotService.attach(
      h.claim.reservedWorkspaceId,
      'https://github.com/org/repo/pull/42'
    );
    await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
    const after = await row();
    expect({ ...after, result: before.result }).toEqual({ ...before, workspaceId: null });
    expect(h.owner.agentRunResultSchema.parse(after.result).pullRequests).toEqual(
      expect.arrayContaining([{ url: 'https://github.com/org/repo/pull/42', number: 42 }])
    );
    expect(await h.read()).toEqual(evidence);
  }
);

it('captures across an actual explicit retry without erasing results, provider evidence or the last resolution', async () => {
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  const consumer = createEventRunConsumer();
  await consumer.consumeClaim(h.claim, new AbortController().signal, true);
  await consumer.drain();
  try {
    await finish();
    await db.prisma.agentRun.update({
      where: { id: h.claim.runId },
      data: {
        attemptCount: 4,
        result: {
          version: 1,
          summary: 'First attempt',
          pullRequests: [{ url: 'https://github.com/org/repo/pull/40', number: 40 }],
        },
      },
    });
    const groups = await vi.importActual<
      typeof import('@/backend/services/session/service/acp/acp-owned-group')
    >('@/backend/services/session/service/acp/acp-owned-group');
    vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockImplementation(({ child }) => {
      child.kill();
      return Promise.resolve('LOCAL_RUNTIME_GROUP_STOPPED');
    });
    const old = provider;
    expect(
      await consumer.resolveAmbiguousRun({
        projectId: h.workspaceSource.projectId,
        claim: h.claim,
        attempt: (await h.read()).attempt,
        action: 'RETRY',
      })
    ).toMatchObject({ status: 'RETRIED' });
    await vi.waitFor(() => expect(provider).not.toBe(old));
    await provider.called;
    const before = await row();
    expect(before.attemptGeneration).toBe(2);
    expect(before.attemptCount).toBe(4);
    const evidence = await h.read();
    expect(evidence.evidence?.resolution?.action).toBe('RETRY');
    await h.workspace.workspacePrSnapshotService.attach(
      h.claim.reservedWorkspaceId,
      'https://github.com/org/repo/pull/42'
    );
    await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
    expect(await row()).toEqual({
      ...before,
      workspaceId: null,
      result: {
        version: 1,
        summary: 'First attempt',
        pullRequests: [
          { url: 'https://github.com/org/repo/pull/40', number: 40 },
          { url: 'https://github.com/org/repo/pull/42', number: 42 },
        ],
      },
    });
    expect(await h.read()).toEqual(evidence);
  } finally {
    consumer.closeAdmission();
    provider?.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    await consumer.stop();
  }
});
