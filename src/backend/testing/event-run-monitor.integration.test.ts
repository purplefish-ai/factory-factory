import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createEventDeliveryFixture,
  boundary,
  deferred,
  releaseEventBoundaries,
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
let launch: Promise<unknown>;
let observe: typeof import('@/backend/orchestration/event-run-monitor.orchestrator').observeEventRun;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  h = await createEventDeliveryFixture(db, 'CLAUDE', false, true);
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
  vi.spyOn(h.workspace.gitOpsService, 'prepareWorktreeCreation').mockImplementation(
    async (project, name) => ({
      worktreePath: join(project.worktreeBasePath, name),
      canonicalBasePath: project.worktreeBasePath,
    })
  );
  vi.spyOn(h.workspace.gitOpsService, 'ensureBaseBranchExists').mockResolvedValue();
  vi.spyOn(h.workspace.gitOpsService, 'createWorktree').mockImplementation(
    async (project, name) => {
      const worktreePath = join(project.worktreeBasePath, name);
      await mkdir(worktreePath, { recursive: true });
      return { worktreePath, branchName: 'event-test' };
    }
  );
  const github = await vi.importActual<typeof import('@/backend/services/github')>(
    '@/backend/services/github'
  );
  vi.spyOn(github.githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('fixture');
  const launcher = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  ({ observeEventRun: observe } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-monitor.orchestrator')
  >('@/backend/orchestration/event-run-monitor.orchestrator'));
  launch = launcher.launchEventRun(h.claim, new AbortController().signal);
  await vi.waitFor(() => expect(provider).toBeDefined());
  await provider.called;
}, 30_000);
afterEach(async () => {
  releaseEventBoundaries();
  provider?.response.resolve({ stopReason: 'end_turn' });
  await launch;
  await h.session.acpRuntimeManager.stopAllClients(10).catch(() => undefined);
  h.session.sessionPromptTurnCompletionService.clearAll();
  h.session.sessionDomainService.clearAllSessions();
  expect(process.kill).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await destroyIntegrationDatabase(db);
  provider = undefined!;
});
const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
async function finish() {
  provider.response.resolve({ stopReason: 'end_turn' });
  await launch;
}
const goal = (active: boolean) =>
  provider.update({
    sessionUpdate: 'session_info_update',
    _meta: { jetbrains: { air: { goal: active ? { status: 'active' } : null } } },
  });
it.each(['goal', 'child', 'turn', 'task', 'request', 'prompt'] as const)(
  'holds %s work and settles only after its authoritative end',
  async (kind) => {
    await finish();
    if (kind === 'goal') {
      goal(true);
    }
    if (kind === 'child') {
      provider.update({
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'child',
        name: 'Child',
        task: 'Work',
      });
    }
    if (kind === 'turn' || kind === 'task') {
      provider.update({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'work', taskType: kind });
    }
    if (kind === 'request') {
      h.session.sessionDomainService.setPendingInteractiveRequest(h.attempt.sessionId, {
        requestId: 'approval',
        toolName: 'Bash',
        toolUseId: 'tool',
        input: {},
        planContent: null,
        timestamp: new Date().toISOString(),
      });
    }
    if (kind === 'prompt') {
      provider.handle.isPromptInFlight = true;
    }
    expect(await observe(h.claim)).toBe('HELD');
    expect(await row()).toMatchObject({ status: 'RUNNING' });
    if (kind === 'goal') {
      goal(false);
    }
    if (kind === 'child') {
      provider.update({
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'child',
        state: 'completed',
      });
    }
    if (kind === 'turn' || kind === 'task') {
      provider.update({
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'work',
        state: 'completed',
      });
    }
    if (kind === 'request') {
      h.session.sessionDomainService.clearPendingInteractiveRequest(h.attempt.sessionId);
    }
    if (kind === 'prompt') {
      provider.handle.isPromptInFlight = false;
    }
    expect(await observe(h.claim)).toBe('SETTLED');
  }
);
it.each(['missing', 'replay', 'replayed', 'source', 'lifecycle'] as const)(
  'does not turn %s coverage into zero-work proof',
  async (kind) => {
    await finish();
    if (kind === 'missing') {
      h.session.eventOwnedWork.forget(h.attempt.sessionId);
    }
    if (kind === 'replay' || kind === 'replayed') {
      provider.handle.nativeSessionTracker!.beginHistoryReplay();
    }
    if (kind === 'replayed') {
      provider.handle.nativeSessionTracker!.completeHistoryReplay();
    }
    if (kind === 'source') {
      provider.handle.providerSessionId = 'replacement';
    }
    if (kind === 'lifecycle') {
      provider.handle.eventLifecycleGeneration!++;
    }
    expect(await observe(h.claim)).toBe('HELD');
    expect(await row()).toMatchObject({ status: 'RUNNING' });
  }
);
it('holds idle-looking state before the correlated initial outcome', async () => {
  provider.handle.isPromptInFlight = false;
  expect(await observe(h.claim)).toBe('HELD');
  expect(await row()).toMatchObject({ status: 'RUNNING' });
});
it('holds non-archived FF child workspaces independently of native zero counts', async () => {
  await finish();
  const workspace = await db.prisma.workspace.findUniqueOrThrow({
    where: { id: h.claim.reservedWorkspaceId },
  });
  const child = await db.prisma.workspace.create({
    data: { name: 'Child', projectId: workspace.projectId, parentWorkspaceId: workspace.id },
  });
  expect(await observe(h.claim)).toBe('HELD');
  await db.prisma.workspace.update({ where: { id: child.id }, data: { status: 'ARCHIVED' } });
  expect(await observe(h.claim)).toBe('SETTLED');
});
it.each(['work', 'source', 'replay', 'prompt'] as const)(
  'rolls back a terminal owner write when %s changes while persistence is pending',
  async (kind) => {
    await finish();
    const writes = await vi.importActual<
      typeof import('@/backend/services/agent-definition/resources/agent-run-settlement-writes')
    >('@/backend/services/agent-definition/resources/agent-run-settlement-writes');
    const gate = boundary();
    const write = writes.writeRunSettlement;
    vi.spyOn(writes, 'writeRunSettlement').mockImplementation(async (...args) => {
      await write(...args);
      await gate.wait();
    });
    const settling = observe(h.claim);
    void settling.catch(() => undefined);
    await gate.entered;
    if (kind === 'work') {
      goal(true);
      goal(false);
    }
    if (kind === 'source') {
      provider.handle.providerSessionId = 'replacement';
    }
    if (kind === 'replay') {
      provider.handle.nativeSessionTracker!.beginHistoryReplay();
      provider.handle.nativeSessionTracker!.completeHistoryReplay();
    }
    if (kind === 'prompt') {
      provider.handle.isPromptInFlight = true;
      provider.handle.isPromptInFlight = false;
    }
    gate.release();
    await expect(settling).rejects.toThrow('observation changed');
    expect(await row()).toMatchObject({
      status: 'RUNNING',
      launchPhase: 'ACTIVE',
      completedAt: null,
    });
    expect((await h.read()).evidence?.work).toBeUndefined();
  }
);
it('unions PR results while held and preserves success despite a later ordinary failed turn', async () => {
  await finish();
  goal(true);
  const pr = await h.workspace.workspacePrSnapshotService.attach(
    h.claim.reservedWorkspaceId,
    'https://github.com/org/repo/pull/42'
  );
  expect(await observe(h.claim)).toBe('HELD');
  expect(await row()).toMatchObject({ result: { pullRequests: [{ number: 42 }] } });
  await db.prisma.workspacePR.delete({ where: { id: pr.prId } });
  const initial = (await h.read()).evidence?.outcome;
  provider.connection.prompt.mockRejectedValueOnce(new Error('Later human failure'));
  await expect(
    h.session.sessionService.sendSessionMessage(h.attempt.sessionId, 'Follow up')
  ).rejects.toThrow('Later human failure');
  expect((await h.read()).evidence?.outcome).toEqual(initial);
  goal(false);
  expect(await observe(h.claim)).toBe('SETTLED');
  expect(await row()).toMatchObject({
    status: 'PR_CREATED',
    result: { pullRequests: [{ number: 42 }] },
  });
});

it('settles the original four-hour send timeout only after strict owned stop', async () => {
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
  provider.child.once('exit', () => provider.response.reject(new Error('Transport closed')));
  await db.prisma.agentInitialDelivery.update({
    where: { runId: h.claim.runId },
    data: { sendingAt: new Date(Date.now() - 4 * 60 * 60 * 1000 - 1) },
  });
  expect(await observe(h.claim)).toBe('SETTLED');
  expect(await row()).toMatchObject({ status: 'FAILED', launchPhase: 'FINISHED' });
  expect((await h.read()).evidence?.stop).toMatchObject({
    cause: 'TIMEOUT',
    status: 'LOCAL_RUNTIME_GROUP_STOPPED',
  });
});

it('requires strict runtime stop for a cancelled terminal response', async () => {
  provider.response.resolve({ stopReason: 'cancelled' });
  await launch;
  expect(await observe(h.claim)).toBe('HELD');
  expect(await row()).toMatchObject({ status: 'RUNNING' });
}, 15_000);

it('settles deliberate user stop only with correlated stop and known tracked-work resolution', async () => {
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
  await h.session.sessionLifecycleService.stopSession(h.attempt.sessionId, { reason: 'USER_STOP' });
  provider.response.resolve({ stopReason: 'cancelled' });
  await launch;
  expect(await observe(h.claim)).toBe('SETTLED');
  expect(await row()).toMatchObject({ status: 'CANCELLED' });
});

it('rejects targeted stop if the expected attempt or source changed, without stopping a human runtime', async () => {
  await finish();
  const fence = await h.read();
  provider.handle.providerSessionId = 'human-runtime';
  await expect(
    h.session.interruptEventInitial(h.attempt.sessionId, 'TIMEOUT', {
      attempt: fence.attempt,
      source: fence.evidence!.source!,
      assertCurrent: () => undefined,
    })
  ).rejects.toThrow();
  expect(provider.child.kill).not.toHaveBeenCalled();
  expect((await h.read()).evidence?.stop).toBeUndefined();
});

it.each(['ARCHIVED', 'deleted'] as const)(
  'requires strict cleanup on workspace %s and retains captured PR results',
  async (state) => {
    await h.workspace.workspacePrSnapshotService.attach(
      h.claim.reservedWorkspaceId,
      'https://github.com/org/repo/pull/42'
    );
    expect(await observe(h.claim)).toBe('HELD');
    const groups = await vi.importActual<
      typeof import('@/backend/services/session/service/acp/acp-owned-group')
    >('@/backend/services/session/service/acp/acp-owned-group');
    vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
    provider.child.once('exit', () => provider.response.reject(new Error('Transport closed')));
    if (state === 'deleted') {
      await h.workspace.workspaceDataService.delete(h.claim.reservedWorkspaceId);
    } else {
      await db.prisma.workspace.update({
        where: { id: h.claim.reservedWorkspaceId },
        data: { status: state },
      });
    }
    expect(await observe(h.claim)).toBe('SETTLED');
    expect(await row()).toMatchObject({
      status: 'CANCELLED',
      result: { pullRequests: [{ number: 42 }] },
    });
  }
);

it('observes a crashed provider as FAILED only after resolving its local stop and tracked work', async () => {
  goal(true);
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
  provider.child.exitCode = 1;
  provider.child.emit('exit', 1, null);
  provider.child.emit('close', 1, null);
  await vi.waitFor(async () =>
    expect((await h.read()).evidence?.stop?.cause).toBe('UNEXPECTED_EXIT')
  );
  provider.response.reject(new Error('Provider crashed'));
  await launch;
  expect(await observe(h.claim)).toBe('HELD');
  goal(false);
  expect(await observe(h.claim)).toBe('SETTLED');
  expect(await row()).toMatchObject({ status: 'FAILED' });
});

it.each([false, true])(
  'adopts FINISHED observation without sending again (coverage lost=%s)',
  async (lost) => {
    await finish();
    if (lost) {
      h.session.eventOwnedWork.forget(h.attempt.sessionId);
    }
    await db.prisma.agentRun.update({
      where: { id: h.claim.runId },
      data: { leaseExpiresAt: new Date(0) },
    });
    const { createEventRunConsumer } = await vi.importActual<
      typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
    >('@/backend/orchestration/event-run-consumer.orchestrator');
    const consumer = createEventRunConsumer();
    await consumer.maintain(new AbortController().signal);
    await consumer.drain();
    await consumer.maintain(new AbortController().signal);
    expect(await row()).toMatchObject({
      status: lost ? 'RUNNING' : 'COMPLETED',
      workerGeneration: h.claim.workerGeneration + 1,
      attemptCount: 1,
    });
    expect(provider.connection.prompt).toHaveBeenCalledOnce();
    await consumer.stop();
  }
);

it('rechecks expected stop source after the authority read await', async () => {
  const fence = await h.read();
  const gate = boundary();
  const read = h.session.eventSessionAuthority.read.bind(h.session.eventSessionAuthority);
  vi.spyOn(h.session.eventSessionAuthority, 'read').mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    await gate.wait();
    return result;
  });
  const stop = h.session.interruptEventInitial(h.attempt.sessionId, 'TIMEOUT', {
    attempt: fence.attempt,
    source: fence.evidence!.source!,
    assertCurrent: () => undefined,
  });
  void stop.catch(() => undefined);
  await gate.entered;
  provider.handle.providerSessionId = 'replacement';
  gate.release();
  await expect(stop).rejects.toThrow('source changed');
  expect(provider.child.kill).not.toHaveBeenCalled();
});

it('preserves an ordinary follow-up during cleanup of a cancelled initial outcome', async () => {
  provider.response.resolve({ stopReason: 'cancelled' });
  await launch;
  const reply = deferred<{ stopReason: 'end_turn' }>();
  provider.connection.prompt.mockImplementationOnce(async () => reply.promise);
  const human = h.session.sessionService.sendSessionMessage(h.attempt.sessionId, 'Human follow-up');
  await vi.waitFor(() => expect(provider.connection.prompt).toHaveBeenCalledTimes(2));
  try {
    expect(await observe(h.claim)).toBe('HELD');
    expect(provider.child.kill).not.toHaveBeenCalled();
  } finally {
    reply.resolve({ stopReason: 'end_turn' });
    await human;
  }
  expect((await h.read()).evidence?.outcome?.result).toBe('CANCELLED');
}, 15_000);

it('retains a PR created before initial provider failure without turning failure into success', async () => {
  await h.workspace.workspacePrSnapshotService.attach(
    h.claim.reservedWorkspaceId,
    'https://github.com/org/repo/pull/42'
  );
  expect(await observe(h.claim)).toBe('HELD');
  provider.response.resolve({
    stopReason: 'end_turn',
    _meta: {
      jetbrains: { air: { sessionFailure: { severity: 'error', title: 'Provider failed' } } },
    },
  });
  await launch;
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
  expect(await observe(h.claim)).toBe('SETTLED');
  expect(await row()).toMatchObject({
    status: 'FAILED',
    result: { pullRequests: [{ number: 42 }] },
  });
  expect((await h.read()).evidence?.outcome?.result).toBe('FAILED');
});

it('does not convert a failed authoritative read into an empty successful workspace', async () => {
  await finish();
  vi.spyOn(h.workspace.workspaceDataService, 'findById').mockRejectedValueOnce(
    new Error('Read unavailable')
  );
  await expect(observe(h.claim)).rejects.toThrow('Read unavailable');
  expect(await row()).toMatchObject({ status: 'RUNNING', completedAt: null });
  expect(provider.connection.prompt).toHaveBeenCalledOnce();
});
