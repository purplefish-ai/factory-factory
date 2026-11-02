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
it('retains a known FF child after archive and deletion without treating either as cleanup proof', async () => {
  await finish();
  const child = await h.creation.create({
    type: 'CHILD_WORKSPACE',
    projectId: h.workspaceSource.projectId,
    parentWorkspaceId: h.claim.reservedWorkspaceId,
    name: 'Child',
  });
  expect(await observe(h.claim)).toBe('HELD');
  await db.prisma.workspace.update({ where: { id: child.id }, data: { status: 'ARCHIVED' } });
  expect(await observe(h.claim)).toBe('HELD');
  await h.workspace.workspaceDataService.delete(child.id);
  expect(await observe(h.claim)).toBe('HELD');
});

it('holds when historical child-history coverage is missing', async () => {
  await finish();
  await db.prisma.workspaceLaunchOrigin.delete({ where: { runId: h.claim.runId } });
  expect(await observe(h.claim)).toBe('HELD');
  expect(await row()).toMatchObject({ status: 'RUNNING' });
});

it.each(['archive', 'delete'] as const)(
  'retains ordinary child work after %s swallows unconfirmed physical cleanup',
  async (operation) => {
    await finish();
    const parentProvider = provider;
    const child = await h.creation.create({
      type: 'CHILD_WORKSPACE',
      projectId: h.workspaceSource.projectId,
      parentWorkspaceId: h.claim.reservedWorkspaceId,
      name: 'Ordinary child',
    });
    await h.workspace.workspaceStateMachine.startProvisioning(child.id);
    await h.workspace.workspaceRunScriptService.registerInitializedWorktree(child.id, {
      worktreePath: db.tempDir,
      branchName: 'child',
      isAutoGeneratedBranch: false,
      runScriptCommand: null,
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: null,
    });
    await h.workspace.workspaceStateMachine.markReady(child.id);
    const childSession = await h.session.sessionDataService.createAgentSession({
      workspaceId: child.id,
      workflow: 'followup',
      provider: 'CLAUDE',
      name: 'Child chat',
    });
    await h.session.sessionLifecycleService.startSession(childSession.id, { initialPrompt: '' });
    const turn = h.session.sessionService.sendSessionMessage(childSession.id, 'Child work');
    void turn.catch(() => undefined);
    await vi.waitFor(() => expect(provider).not.toBe(parentProvider));
    const childProvider = provider;
    provider = parentProvider;
    await childProvider.called;
    const stopped = vi
      .spyOn(h.session.acpRuntimeManager, 'stopAndQuiesce')
      .mockRejectedValue(new Error('Unconfirmed child cleanup'));
    const archives = await vi.importActual<
      typeof import('@/backend/orchestration/workspace-archive.orchestrator')
    >('@/backend/orchestration/workspace-archive.orchestrator');
    const children = await vi.importActual<
      typeof import('@/backend/orchestration/workspace-children.orchestrator')
    >('@/backend/orchestration/workspace-children.orchestrator');
    vi.spyOn(children, 'fireLifecycleNotification').mockResolvedValue();
    vi.spyOn(h.workspace.worktreeLifecycleService, 'cleanupWorkspaceWorktree').mockResolvedValue();
    const services = {
      sessionLifecycleService: h.session.sessionLifecycleService,
      runScriptService: {
        stopRunScript: async () => ({ success: true }),
        evictWorkspaceBuffers: () => undefined,
      },
      terminalService: { destroyWorkspaceTerminals: () => undefined },
      cleanupWorkspaceScopedCaches: () => undefined,
      githubCLIService: { addIssueComment: async () => undefined },
    };
    try {
      const workspace = await h.workspace.workspaceDataService.findByIdWithProject(child.id);
      if (operation === 'archive') {
        await archives.archiveWorkspace(workspace!, {}, services);
      } else {
        await archives.cleanupWorkspaceRuntimeResources(child.id, services, 'delete');
        await h.workspace.workspaceDataService.delete(child.id);
      }
      expect(stopped).toHaveBeenCalledWith(childSession.id);
      expect(childProvider.handle.isRunning()).toBe(true);
      expect(await observe(h.claim)).toBe('HELD');
      expect(await row()).toMatchObject({ status: 'RUNNING' });
    } finally {
      stopped.mockRestore();
      childProvider.response.resolve({ stopReason: 'end_turn' });
      await turn;
    }
  }
);
it.each(['work', 'source', 'replay', 'prompt', 'child-tool', 'child-text'] as const)(
  'rolls back a terminal owner write when %s changes while persistence is pending',
  async (kind) => {
    await finish();
    if (kind === 'child-tool' || kind === 'child-text') {
      provider.update({
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'child',
        name: 'Child',
      });
      provider.update({
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'child',
        state: 'completed',
      });
    }
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
    if (kind === 'child-tool' || kind === 'child-text') {
      provider.handle.nativeSessionTracker!.onRawMessage({
        method: 'session/update',
        params: {
          sessionId: 'child',
          update:
            kind === 'child-tool'
              ? {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'late-tool',
                  title: 'Late tool',
                  status: 'in_progress',
                }
              : {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Late output' },
                },
        },
      });
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
    if (lost) {
      await expect(h.owner.eventRunLaunch.read(h.claim)).rejects.toThrow();
    }
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

it.each(['lifecycle', 'retained stop source'] as const)(
  'rolls back stopped settlement when its %s changes during owner persistence',
  async (changed) => {
    const groups = await vi.importActual<
      typeof import('@/backend/services/session/service/acp/acp-owned-group')
    >('@/backend/services/session/service/acp/acp-owned-group');
    vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
    await h.session.sessionLifecycleService.stopSession(h.attempt.sessionId, {
      reason: 'USER_STOP',
    });
    provider.response.resolve({ stopReason: 'cancelled' });
    await launch;
    const writes = await vi.importActual<
      typeof import('@/backend/services/agent-definition/resources/agent-run-settlement-writes')
    >('@/backend/services/agent-definition/resources/agent-run-settlement-writes');
    const { sessionLifecycleGate } = await vi.importActual<
      typeof import('@/backend/services/session/service/lifecycle/session-core-services')
    >('@/backend/services/session/service/lifecycle/session-core-services');
    const gate = boundary();
    const write = writes.writeRunSettlement;
    vi.spyOn(writes, 'writeRunSettlement').mockImplementation(async (...args) => {
      await write(...args);
      await gate.wait();
    });
    const settling = observe(h.claim);
    void settling.catch(() => undefined);
    await gate.entered;
    if (changed === 'lifecycle') {
      const reservation = sessionLifecycleGate.reserveStop(h.attempt.sessionId);
      expect(reservation).not.toBeNull();
      reservation?.release();
    } else {
      vi.spyOn(h.session.acpRuntimeManager, 'getRuntimeStopSource').mockReturnValue(null);
    }
    gate.release();
    await expect(settling).rejects.toThrow('observation changed');
    expect(await row()).toMatchObject({ status: 'RUNNING', completedAt: null });
    expect((await h.read()).evidence?.work).toBeUndefined();
  }
);

it.each([
  ['source', 'reject'],
  ['source', 'timeout'],
  ['work', 'reject'],
  ['work', 'timeout'],
  ['revoked', 'reject'],
  ['revoked', 'timeout'],
] as const)(
  'never starts physical targeted stop after %s changes and ownership lookup %s',
  async (changed, failure) => {
    await finish();
    const fence = await h.read();
    const source = fence.evidence!.source!;
    const work = h.session.eventOwnedWork.observe(fence.attempt, source)!;
    const gate = boundary();
    vi.spyOn(h.session.eventSessionAuthority, 'isOwned').mockImplementationOnce(async () => {
      await gate.wait();
      throw new Error('Owner unavailable');
    });
    const ordinary = vi.spyOn(h.session.acpRuntimeManager, 'stopAndQuiesce').mockResolvedValue();
    const strict = vi.spyOn(h.session.acpRuntimeManager, 'stopAndQuiesceObserved');
    let current = true;
    if (failure === 'timeout') {
      vi.useFakeTimers();
    }
    const stop = h.session.interruptEventInitial(h.attempt.sessionId, 'SYSTEM_STOP', {
      attempt: fence.attempt,
      source,
      assertCurrent: () => {
        if (!current) {
          throw new Error('Owner revoked');
        }
        work.assertWorkCurrent();
      },
    });
    const rejected = expect(stop).rejects.toThrow();
    await gate.entered;
    if (changed === 'source') {
      provider.handle.providerSessionId = 'replacement';
    } else if (changed === 'work') {
      goal(true);
    } else {
      current = false;
    }
    if (failure === 'timeout') {
      await vi.advanceTimersByTimeAsync(5001);
    } else {
      gate.release();
    }
    await rejected;
    gate.release();
    await Promise.resolve();
    expect(ordinary).not.toHaveBeenCalled();
    expect(strict).not.toHaveBeenCalled();
  }
);

it.each(['isOwned', 'read'] as const)(
  'fails closed on targeted %s uncertainty even without an optional expected source',
  async (lookup) => {
    vi.spyOn(h.session.eventSessionAuthority, lookup).mockRejectedValueOnce(
      new Error('Owner unavailable')
    );
    const ordinary = vi.spyOn(h.session.acpRuntimeManager, 'stopAndQuiesce').mockResolvedValue();
    const strict = vi.spyOn(h.session.acpRuntimeManager, 'stopAndQuiesceObserved');
    await expect(h.session.interruptEventInitial(h.attempt.sessionId, 'SHUTDOWN')).rejects.toThrow(
      'Owner unavailable'
    );
    expect(ordinary).not.toHaveBeenCalled();
    expect(strict).not.toHaveBeenCalled();
  }
);

it('preserves SHUTDOWN uncertainty after the four-hour deadline', async () => {
  const fence = await h.read();
  const evidence = {
    version: 1 as const,
    cause: 'SHUTDOWN' as const,
    status: 'UNKNOWN' as const,
    source: fence.evidence!.source!,
    observedAt: new Date().toISOString(),
  };
  await h.session.eventSessionAuthority.recordStop(h.attempt.sessionId, evidence);
  await db.prisma.agentInitialDelivery.update({
    where: { runId: h.claim.runId },
    data: { sendingAt: new Date(Date.now() - 4 * 60 * 60 * 1000 - 1) },
  });
  const stop = vi.spyOn(h.session.acpRuntimeManager, 'stopAndQuiesceObserved');
  expect(await observe(h.claim)).toBe('HELD');
  expect(stop).not.toHaveBeenCalled();
  expect((await h.read()).evidence?.stop).toEqual(evidence);
  expect(await row()).toMatchObject({ status: 'RUNNING' });
});

it('never upgrades unknown historical coverage when an event workspace is reused', async () => {
  await finish();
  await db.prisma.workspaceLaunchOrigin.update({
    where: { runId: h.claim.runId },
    data: { childHistoryVersion: null },
  });
  await h.creation.createEventWorkspaceOnce(h.workspaceSource);
  expect(await observe(h.claim)).toBe('HELD');
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: h.claim.runId } })
  ).toMatchObject({ childHistoryVersion: null });
});

it('revokes complete child history when backup import skips an existing event workspace', async () => {
  await finish();
  const { dataBackupService } = await vi.importActual<
    typeof import('@/backend/orchestration/data-backup.service')
  >('@/backend/orchestration/data-backup.service');
  const backup = await dataBackupService.exportData('fixture');
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: h.claim.runId } })
  ).toMatchObject({ childHistoryVersion: 1 });
  const imported = await dataBackupService.importData(backup);
  expect(imported.workspaces.skipped).toBe(1);
  expect(await observe(h.claim)).toBe('HELD');
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: h.claim.runId } })
  ).toMatchObject({ childHistoryVersion: null });
});

it('retains imported child ownership after later deletion', async () => {
  await finish();
  const { dataBackupService } = await vi.importActual<
    typeof import('@/backend/orchestration/data-backup.service')
  >('@/backend/orchestration/data-backup.service');
  const backup = await dataBackupService.exportData('fixture');
  const parent = backup.data.workspaces[0]!;
  backup.data.workspaces = [
    {
      ...parent,
      id: 'imported-child',
      name: 'Imported child',
      parentWorkspaceId: h.claim.reservedWorkspaceId,
      creationSource: 'CHILD_WORKSPACE',
      creationMetadata: null,
    },
  ];
  backup.data.agentSessions = [];
  expect((await dataBackupService.importData(backup)).workspaces.imported).toBe(1);
  expect(
    await db.prisma.workspaceChildOrigin.findMany({
      where: { parentWorkspaceId: h.claim.reservedWorkspaceId },
    })
  ).toEqual([expect.objectContaining({ childWorkspaceId: 'imported-child' })]);
  await h.workspace.workspaceDataService.delete('imported-child');
  expect(await observe(h.claim)).toBe('HELD');
});

it('serializes child creation and its retained origin before parent settlement', async () => {
  await finish();
  const transaction = db.prisma.$transaction.bind(db.prisma);
  const gate = boundary();
  vi.spyOn(db.prisma, '$transaction').mockImplementationOnce((operation) =>
    transaction(async (tx) => {
      const result = await operation(tx);
      await gate.wait();
      return result;
    })
  );
  const creating = h.creation.create({
    type: 'CHILD_WORKSPACE',
    projectId: h.workspaceSource.projectId,
    parentWorkspaceId: h.claim.reservedWorkspaceId,
    name: 'Concurrent child',
  });
  await gate.entered;
  let settled = false;
  const observing = observe(h.claim).then((value) => {
    settled = true;
    return value;
  });
  void observing.catch(() => undefined);
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.release();
  const child = await creating;
  expect(await observing).toBe('HELD');
  await h.workspace.workspaceDataService.delete(child.id);
  expect(await observe(h.claim)).toBe('HELD');
});

it('rolls back child creation if retained ownership cannot be persisted', async () => {
  await finish();
  const transaction = db.prisma.$transaction.bind(db.prisma);
  vi.spyOn(db.prisma, '$transaction').mockImplementationOnce((operation) =>
    transaction((tx) => {
      vi.spyOn(tx.workspaceChildOrigin, 'upsert').mockRejectedValueOnce(
        new Error('Origin unavailable')
      );
      return operation(tx);
    })
  );
  await expect(
    h.creation.create({
      type: 'CHILD_WORKSPACE',
      projectId: h.workspaceSource.projectId,
      parentWorkspaceId: h.claim.reservedWorkspaceId,
      name: 'Uncommitted child',
    })
  ).rejects.toThrow('Origin unavailable');
  expect(
    await db.prisma.workspace.count({ where: { parentWorkspaceId: h.claim.reservedWorkspaceId } })
  ).toBe(0);
  expect(await observe(h.claim)).toBe('SETTLED');
});

it('does not reuse initial stopped-work coverage after a later runtime starts and stops', async () => {
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
  await finish();
  const initialProvider = provider;
  await h.session.sessionLifecycleService.stopSession(h.attempt.sessionId, { reason: 'USER_STOP' });
  const initialStop = (await h.read()).evidence!.stop!;
  await h.session.sessionLifecycleService.startSession(h.attempt.sessionId, { initialPrompt: '' });
  expect(provider).not.toBe(initialProvider);
  await h.session.acpRuntimeManager.stopAndQuiesce(h.attempt.sessionId);
  expect(h.session.acpRuntimeManager.getRuntimeStopSource(h.attempt.sessionId)).not.toEqual(
    initialStop.source
  );
  expect(await observe(h.claim)).toBe('HELD');
  expect(await row()).toMatchObject({ status: 'RUNNING' });
});
