import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createEventDeliveryFixture,
  releaseEventBoundaries,
  boundary,
  deferred,
  drainEventFixtureTasks,
} from '@/backend/orchestration/testing/event-delivery.test-support';
import { fakeEventProvider } from '@/backend/orchestration/testing/event-provider.test-support';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
let consumer: ReturnType<
  typeof import('@/backend/orchestration/event-run-consumer.orchestrator').createEventRunConsumer
>;
let providers: ReturnType<typeof fakeEventProvider>[];
beforeEach(async () => {
  db = await createIntegrationDatabase();
  const accounts = await vi.importActual<typeof import('@/backend/services/codex-accounts')>(
    '@/backend/services/codex-accounts'
  );
  vi.spyOn(accounts.codexAccountService, 'getEnabledAccountIds').mockResolvedValue([
    'event-test-account',
  ]);
  vi.spyOn(accounts.codexAccountService, 'getRuntimeContext').mockImplementation(
    async (id = 'event-test-account') => ({
      accountId: id,
      homeDir: db.tempDir,
      sessionsDir: db.tempDir,
      env: {},
    })
  );
  h = await createEventDeliveryFixture(db, 'CODEX');
  providers = [];
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
    const provider = fakeEventProvider(
      h.session.AcpProcessHandle,
      options,
      undefined,
      new AcpNativeSessionTracker()
    );
    providers.push(provider);
    return Promise.resolve(provider.handle);
  });
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  consumer = createEventRunConsumer();
}, 30_000);
afterEach(async () => {
  releaseEventBoundaries();
  for (const provider of providers) {
    provider.response.resolve({ stopReason: 'end_turn' });
  }
  await consumer.drain();
  await consumer.stop();
  await drainEventFixtureTasks();
  await h.session.acpRuntimeManager.stopAllClients(10).catch(() => undefined);
  h.session.sessionPromptTurnCompletionService.clearAll();
  h.session.sessionDomainService.clearAllSessions();
  expect(process.kill).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await destroyIntegrationDatabase(db);
});

it.each(['admission', 'startup'] as const)(
  'fences unsignalled initial %s before a failed recovery ownership lookup',
  async (stage) => {
    await consumer.consumeClaim(h.claim, new AbortController().signal, true);
    await consumer.drain();
    const input = await context();
    const gate = boundary();
    if (stage === 'admission') {
      const read = h.owner.agentInitialDelivery.readFence.bind(h.owner.agentInitialDelivery);
      vi.spyOn(h.owner.agentInitialDelivery, 'readFence').mockImplementationOnce(
        async (...args) => {
          const fence = await read(...args);
          await gate.wait();
          return fence;
        }
      );
    } else {
      const start = h.session.sessionLifecycleService.getOrCreateSessionClient.bind(
        h.session.sessionLifecycleService
      );
      vi.spyOn(
        h.session.sessionLifecycleService,
        'getOrCreateSessionClient'
      ).mockImplementationOnce(async (...args) => {
        await gate.wait();
        return start(...args);
      });
    }
    const dispatch = h.dispatch();
    void dispatch.catch(() => undefined);
    await gate.entered;
    const commit = vi
      .spyOn(h.session.sessionDomainService, 'commitSentUserMessage')
      .mockImplementation(() => {
        throw new Error('Late transcript commit');
      });
    vi.spyOn(h.session.eventSessionAuthority, 'isOwned').mockRejectedValueOnce(
      new Error('Unavailable')
    );
    expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
      status: 'BLOCKED',
    });
    gate.release();
    await expect(dispatch).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
    expect(providers.every((provider) => provider.connection.prompt.mock.calls.length === 0)).toBe(
      true
    );
    expect((await h.read()).state).toBe('PENDING');
  }
);

it.each(['deleted', 'unreadable', 'file'] as const)(
  'reports a %s retry directory as unavailable before any stop',
  async (failure) => {
    const path = await recoveryWorktree();
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    const input = await context();
    expect(await consumer.inspectRun(input)).toMatchObject({ retryResourcesAvailable: true });
    try {
      if (failure === 'unreadable') {
        await chmod(path, 0);
      } else {
        await rm(path, { recursive: true });
        if (failure === 'file') {
          await writeFile(path, 'Not a directory');
        }
      }
      expect(await consumer.inspectRun(input)).toMatchObject({
        retryResourcesAvailable: false,
        retryBlocked: 'RESOURCES_UNAVAILABLE',
        blocked: null,
      });
      await strictStop();
      expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
        status: 'BLOCKED',
        reason: 'RESOURCES_UNAVAILABLE',
      });
      expect(providers[0]!.child.kill).not.toHaveBeenCalled();
      expect(providers).toHaveLength(1);
      expect((await h.read()).attempt).toEqual(input.attempt);
      expect((await h.read()).evidence?.stop).toBeUndefined();
      expect((await row()).status).toBe('RUNNING');
    } finally {
      if (failure === 'unreadable') {
        await chmod(path, 0o700);
      }
    }
  }
);

it.each(['RESOLVE', 'ABANDON'] as const)(
  'allows %s with valid work proof after the retry directory is deleted',
  async (action) => {
    const path = await recoveryWorktree();
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    await rm(path, { recursive: true });
    const input = await context();
    expect(await consumer.inspectRun(input)).toMatchObject({
      retryResourcesAvailable: false,
      retryBlocked: 'RESOURCES_UNAVAILABLE',
      blocked: null,
    });
    await strictStop();
    expect(await consumer.resolveAmbiguousRun({ ...input, action })).toMatchObject({
      status: action === 'RESOLVE' ? 'RESOLVED' : 'ABANDONED',
    });
    expect((await h.read()).evidence?.outcome?.result).toBe('COMPLETED');
    expect(providers).toHaveLength(1);
  }
);

it('rolls back retry as a resource failure when its directory disappears during the owner write', async () => {
  const path = await recoveryWorktree();
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const input = await context();
  const transaction = db.prisma.$transaction.bind(db.prisma);
  const gate = boundary();
  vi.spyOn(db.prisma, '$transaction').mockImplementation((operation) =>
    transaction((tx) => {
      const update = tx.agentRun.update.bind(tx.agentRun);
      const delayedUpdate = async (args: Parameters<typeof update>[0]) => {
        const result = await update(args);
        if (args.data.attemptGeneration === input.attempt.attemptGeneration + 1) {
          await gate.wait();
        }
        return result;
      };
      vi.spyOn(tx.agentRun, 'update').mockImplementation(
        unsafeCoerce<typeof update>(delayedUpdate)
      );
      return operation(tx);
    })
  );
  const recovering = consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' });
  await gate.entered;
  await rm(path, { recursive: true });
  gate.release();
  expect(await recovering).toMatchObject({ status: 'BLOCKED', reason: 'RESOURCES_UNAVAILABLE' });
  expect((await h.read()).attempt).toEqual(input.attempt);
  expect((await h.read()).evidence?.resolution).toBeUndefined();
  expect((await row()).status).toBe('RUNNING');
  expect(providers).toHaveLength(1);
});

async function recoveryWorktree() {
  const path = join(db.tempDir, 'retry-worktree');
  await mkdir(path);
  await db.prisma.workspace.update({
    where: { id: h.claim.reservedWorkspaceId },
    data: { worktreePath: path },
  });
  return path;
}

it('fences pending initial admission through recovery timeout and preserves a replacement permit', async () => {
  await consumer.consumeClaim(h.claim, new AbortController().signal, true);
  await consumer.drain();
  const input = await context();
  const gate = boundary();
  const read = h.owner.agentInitialDelivery.readFence.bind(h.owner.agentInitialDelivery);
  vi.spyOn(h.owner.agentInitialDelivery, 'readFence').mockImplementationOnce(async (...args) => {
    const fence = await read(...args);
    await gate.wait();
    return fence;
  });
  const old = h.dispatch();
  void old.catch(() => undefined);
  await gate.entered;
  const lookup = boundary();
  vi.spyOn(h.session.eventSessionAuthority, 'isOwned').mockImplementation(async () => {
    await lookup.wait();
    return true;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const recovery = consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' });
  await lookup.entered;
  await vi.advanceTimersByTimeAsync(5001);
  expect(await recovery).toMatchObject({ status: 'BLOCKED' });
  vi.useRealTimers();
  // Independent replacement admission for the same durable attempt: old finalizers
  // must compare operation identity, not blindly remove its session's permit.
  const replacementGate = boundary();
  const entered = deferred<void>();
  const replacement = h.session.eventSessionAuthority.runInitial(input.attempt, async (permit) => {
    entered.resolve();
    await replacementGate.wait();
    h.session.eventSessionAuthority.assertCurrent(permit);
  });
  await entered.promise;
  gate.release();
  lookup.release();
  await expect(old).rejects.toThrow();
  replacementGate.release();
  await expect(replacement).resolves.toBeUndefined();
  expect(providers).toHaveLength(0);
});

it.each([
  'goal',
  'child',
  'unknown-history',
  'missing-worktree',
  'replay',
  'deleted-session',
] as const)(
  'blocks retry for %s without rotating identities or releasing capacity',
  async (reason) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    if (reason === 'goal') {
      providers[0]!.update({
        sessionUpdate: 'session_info_update',
        _meta: { jetbrains: { air: { goal: { status: 'active' } } } },
      });
    }
    if (reason === 'child') {
      await h.creation.create({
        projectId: h.workspaceSource.projectId,
        name: 'Child',
        type: 'CHILD_WORKSPACE',
        parentWorkspaceId: h.claim.reservedWorkspaceId,
      });
    }
    if (reason === 'unknown-history') {
      await db.prisma.workspaceLaunchOrigin.update({
        where: { runId: h.claim.runId },
        data: { childHistoryVersion: null },
      });
    }
    if (reason === 'missing-worktree') {
      await db.prisma.workspace.update({
        where: { id: h.claim.reservedWorkspaceId },
        data: { worktreePath: '/missing/event-worktree' },
      });
    }
    if (reason === 'replay') {
      providers[0]!.handle.nativeSessionTracker!.beginHistoryReplay();
      providers[0]!.handle.nativeSessionTracker!.completeHistoryReplay();
    }
    if (reason === 'deleted-session') {
      await db.prisma.agentSession.delete({ where: { id: h.attempt.sessionId } });
    }
    await strictStop();
    const input = await context();
    expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
      status: 'BLOCKED',
      reason: {
        goal: 'WORK_PROOF_UNAVAILABLE',
        child: 'CHILD_WORK_UNPROVEN',
        'unknown-history': 'CHILD_WORK_UNPROVEN',
        'missing-worktree': 'RESOURCES_UNAVAILABLE',
        replay: 'WORK_PROOF_UNAVAILABLE',
        'deleted-session': 'RESOURCES_UNAVAILABLE',
      }[reason],
    });
    expect((await h.read()).attempt).toEqual(input.attempt);
    expect((await row()).status).toBe('RUNNING');
    expect(providers).toHaveLength(1);
  }
);

it('rejects a wrong project before cancelling the current initial operation', async () => {
  await launch();
  const input = await context();
  await expect(
    consumer.resolveAmbiguousRun({ ...input, projectId: 'other-project', action: 'ABANDON' })
  ).rejects.toThrow();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  expect((await h.read()).evidence?.outcome?.result).toBe('COMPLETED');
});

it('retains an explicit resolution without inventing a provider result and permits a later exact retry', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  const input = await context();
  const outcome = (await h.read()).evidence?.outcome;
  await strictStop();
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RESOLVE' })).toMatchObject({
    status: 'RESOLVED',
  });
  expect((await h.read()).evidence?.outcome).toEqual(outcome);
  await consumer.maintain(new AbortController().signal);
  expect((await row()).status).toBe('RUNNING');
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
    status: 'RETRIED',
  });
  await vi.waitFor(() => expect(providers).toHaveLength(2));
});

it('keeps old replayed zeroes unproven but establishes new coverage after independently proved old work', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  const { AcpNativeSessionTracker } = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-native-session-tracker')
  >('@/backend/services/session/service/acp/acp-native-session-tracker');
  vi.mocked(factory.AcpClientFactory.prototype.createClient).mockImplementationOnce(
    ({ options }) => {
      const tracker = new AcpNativeSessionTracker();
      tracker.beginHistoryReplay();
      tracker.completeHistoryReplay();
      const next = fakeEventProvider(h.session.AcpProcessHandle, options, undefined, tracker);
      providers.push(next);
      return Promise.resolve(next.handle);
    }
  );
  expect(
    await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
  ).toMatchObject({ status: 'RETRIED' });
  await vi.waitFor(() => expect(providers).toHaveLength(2));
  await providers[1]!.called;
  providers[1]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await consumer.maintain(new AbortController().signal);
  expect((await row()).status).toBe('COMPLETED');
});
it('blocks pending retry startup when the old live proof is lost after rotation', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const resolve = h.owner.eventRunRecovery.resolve.bind(h.owner.eventRunRecovery);
  vi.spyOn(h.owner.eventRunRecovery, 'resolve').mockImplementationOnce(async (...args) => {
    const result = await resolve(...args);
    h.session.eventOwnedWork.forget(h.attempt.sessionId);
    return result;
  });
  expect(
    await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
  ).toMatchObject({ status: 'RETRIED' });
  await vi.waitFor(async () => expect((await row()).launchPhase).toBe('NEEDS_ATTENTION'));
  expect(providers).toHaveLength(1);
  expect((await h.read()).state).toBe('PENDING');
  expect((await row()).status).toBe('RUNNING');
  expect(await consumer.inspectRun(await context())).toMatchObject({
    blocked: 'PREVIOUS_WORK_PROOF_UNAVAILABLE',
  });
});

it('rechecks resolved work after an ordinary replacement starts and stops', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const input = await context();
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RESOLVE' })).toMatchObject({
    status: 'RESOLVED',
  });
  await h.session.sessionLifecycleService.startSession(h.attempt.sessionId, { initialPrompt: '' });
  await h.session.acpRuntimeManager.stopAndQuiesce(h.attempt.sessionId);
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
    status: 'BLOCKED',
  });
  expect((await h.read()).attempt).toEqual(input.attempt);
});

it('keeps a committed rotation pending if shutdown closes the consumer before replacement handoff', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const input = await context();
  const resolve = h.owner.eventRunRecovery.resolve.bind(h.owner.eventRunRecovery);
  vi.spyOn(h.owner.eventRunRecovery, 'resolve').mockImplementationOnce(async (...args) => {
    const result = await resolve(...args);
    consumer.closeAdmission();
    return result;
  });
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
    status: 'BLOCKED',
  });
  expect((await h.read()).attempt.attemptGeneration).toBe(input.attempt.attemptGeneration + 1);
  expect((await h.read()).state).toBe('PENDING');
  expect((await row()).status).toBe('RUNNING');
  expect(providers).toHaveLength(1);
});

it('does not stop an active ordinary human follow-up', async () => {
  await launch();
  const provider = providers[0]!;
  provider.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  const reply = deferred<{ stopReason: 'end_turn' }>();
  provider.connection.prompt.mockImplementationOnce(async () => reply.promise);
  const human = h.session.sessionService.sendSessionMessage(h.attempt.sessionId, 'Human follow-up');
  await vi.waitFor(() => expect(provider.connection.prompt).toHaveBeenCalledTimes(2));
  try {
    await strictStop();
    expect(
      await consumer.resolveAmbiguousRun({ ...(await context()), action: 'ABANDON' })
    ).toMatchObject({ status: 'BLOCKED' });
    expect(provider.child.kill).not.toHaveBeenCalled();
  } finally {
    reply.resolve({ stopReason: 'end_turn' });
    await human;
  }
});

it('abandons with explicit decision evidence while preserving provider outcome and retained results', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  const outcome = (await h.read()).evidence?.outcome;
  const result = {
    version: 1,
    summary: '',
    pullRequests: [{ url: 'https://github.com/org/repo/pull/42', number: 42 }],
  };
  await db.prisma.agentRun.update({ where: { id: h.claim.runId }, data: { result } });
  await strictStop();
  expect(
    await consumer.resolveAmbiguousRun({ ...(await context()), action: 'ABANDON' })
  ).toMatchObject({ status: 'ABANDONED' });
  expect((await h.read()).evidence).toMatchObject({ outcome, resolution: { action: 'ABANDON' } });
  expect(await row()).toMatchObject({
    status: 'CANCELLED',
    launchPhase: 'FINISHED',
    leaseExpiresAt: null,
    result,
  });
});
it('blocks unknown setup cleanup without invoking a runtime stop', async () => {
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: {
      launchPreparation: { version: 1, state: 'UNKNOWN', setupStartedAt: new Date().toISOString() },
    },
  });
  await consumer.consumeClaim(h.claim, new AbortController().signal, true);
  await consumer.drain();
  const input = await context();
  expect(await consumer.inspectRun(input)).toMatchObject({
    blocked: 'PREPARATION_CLEANUP_UNCERTAIN',
  });
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'ABANDON' })).toMatchObject({
    status: 'BLOCKED',
    reason: 'PREPARATION_CLEANUP_UNCERTAIN',
  });
  expect(providers).toHaveLength(0);
  expect((await row()).status).toBe('RUNNING');
});

it('blocks an unconfirmed physical stop without rotating the send', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockResolvedValue('UNKNOWN');
  const input = await context();
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
    status: 'BLOCKED',
  });
  expect((await h.read()).attempt).toEqual(input.attempt);
  expect((await row()).status).toBe('RUNNING');
});

it('rejects stale claim and current-send identities before cancelling or stopping', async () => {
  await launch();
  const input = await context();
  for (const mutation of [
    { claim: { ...input.claim, workerGeneration: input.claim.workerGeneration + 1 } },
    { claim: { ...input.claim, attemptGeneration: input.claim.attemptGeneration + 1 } },
    { attempt: { ...input.attempt, messageId: 'stale-message' } },
    { attempt: { ...input.attempt, sendAttemptId: 'stale-send' } },
  ]) {
    await expect(
      consumer.resolveAmbiguousRun({ ...input, ...mutation, action: 'RETRY' })
    ).rejects.toThrow();
  }
  expect(providers[0]!.child.kill).not.toHaveBeenCalled();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  expect((await h.read()).evidence?.outcome?.result).toBe('COMPLETED');
});
it('retries an active initial operation and fences its late callback and release', async () => {
  await launch();
  await strictStop();
  const input = await context();
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
    status: 'RETRIED',
  });
  await vi.waitFor(() => expect(providers).toHaveLength(2));
  await providers[1]!.called;
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await vi.waitFor(() => expect(providers[0]!.handle.isPromptInFlight).toBe(false));
  expect((await h.read()).attempt.attemptGeneration).toBe(input.attempt.attemptGeneration + 1);
  expect((await h.read()).evidence?.outcome).toBeUndefined();
  expect((await h.read()).evidence?.resolution?.outcome).toBeUndefined();
  await consumer.maintain(new AbortController().signal);
  expect((await row()).status).toBe('RUNNING');
  providers[1]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await consumer.maintain(new AbortController().signal);
  expect((await row()).status).toBe('COMPLETED');
});

it('fences in-flight maintenance without aborting into a second untargeted stop', async () => {
  await launch();
  await strictStop();
  const renew = h.owner.eventRunLaunch.renew.bind(h.owner.eventRunLaunch);
  const gate = boundary();
  vi.spyOn(h.owner.eventRunLaunch, 'renew').mockImplementationOnce(async (...args) => {
    const lease = await renew(...args);
    await gate.wait();
    return lease;
  });
  const maintenance = consumer.maintain(new AbortController().signal);
  await gate.entered;
  const cancel = vi.spyOn(h.session.eventSessionAuthority, 'cancelInitial');
  const stops = vi.spyOn(h.owner.agentInitialDelivery, 'stop');
  const recovery = consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' });
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  gate.release();
  expect(await recovery).toMatchObject({ status: 'RETRIED' });
  await maintenance;
  await vi.waitFor(() => expect(providers).toHaveLength(2));
  await providers[1]!.called;
  expect(stops.mock.calls.every(([, evidence]) => evidence.cause === 'SYSTEM_STOP')).toBe(true);
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  providers[1]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await consumer.maintain(new AbortController().signal);
  expect((await row()).status).toBe('COMPLETED');
});

it('fences failure cleanup after its captured handoff read while recovery starts a replacement', async () => {
  const launcher = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  const launchRun = launcher.launchEventRun;
  let oldLaunch: ReturnType<typeof launchRun> | undefined;
  vi.spyOn(launcher, 'launchEventRun').mockImplementationOnce((...args) => {
    oldLaunch = launchRun(...args);
    return oldLaunch;
  });
  await launch();
  const read = h.owner.eventRunLaunch.read.bind(h.owner.eventRunLaunch);
  const gate = boundary();
  vi.spyOn(h.owner.eventRunLaunch, 'read').mockImplementationOnce(async (...args) => {
    const snapshot = await read(...args);
    await gate.wait();
    return snapshot;
  });
  providers[0]!.response.reject(new Error('Provider connection lost'));
  await gate.entered;
  await strictStop();
  const dispose = vi.spyOn(h.owner.eventRunLaunch, 'dispose');
  expect(
    await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
  ).toMatchObject({ status: 'RETRIED' });
  await vi.waitFor(() => expect(providers).toHaveLength(2));
  await providers[1]!.called;
  const invalidate = vi.spyOn(h.session.eventSessionAuthority, 'invalidate');
  gate.release();
  await oldLaunch?.catch(() => undefined);
  expect(providers[1]!.child.kill).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  providers[1]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  expect((await h.read()).evidence?.outcome?.result).toBe('COMPLETED');
});

it.each(['ownership', 'fence'] as const)(
  'fences failure cleanup cancelled during its stop %s lookup',
  async (stage) => {
    vi.spyOn(h.session.sessionDomainService, 'commitSentUserMessage').mockImplementationOnce(() => {
      throw new Error('Transcript unavailable');
    });
    const gate = boundary();
    let paused = false;
    if (stage === 'ownership') {
      const isOwned = h.session.eventSessionAuthority.isOwned.bind(h.session.eventSessionAuthority);
      vi.spyOn(h.session.eventSessionAuthority, 'isOwned').mockImplementation(async (...args) => {
        const result = await isOwned(...args);
        // Startup performs the first lookup; cleanup is the first one after failure.
        if (providers.length && !paused) {
          paused = true;
          await gate.wait();
        }
        return result;
      });
    } else {
      const read = h.session.eventSessionAuthority.read.bind(h.session.eventSessionAuthority);
      vi.spyOn(h.session.eventSessionAuthority, 'read').mockImplementation(async (...args) => {
        const result = await read(...args);
        if (providers.length && !paused) {
          paused = true;
          await gate.wait();
        }
        return result;
      });
    }
    await consumer.consumeClaim(h.claim, new AbortController().signal);
    await gate.entered;
    const input = await context();
    const dispose = vi.spyOn(h.owner.eventRunLaunch, 'dispose');
    expect(await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' })).toMatchObject({
      status: 'BLOCKED',
    });
    const replacementEntered = deferred<void>();
    const replacementGate = boundary();
    const replacement = h.session.eventSessionAuthority.runInitial(
      input.attempt,
      async (permit) => {
        replacementEntered.resolve();
        await replacementGate.wait();
        h.session.eventSessionAuthority.assertCurrent(permit);
      }
    );
    await replacementEntered.promise;
    gate.release();
    await consumer.drain();
    replacementGate.release();
    await expect(replacement).resolves.toBeUndefined();
    expect(providers[0]!.child.kill).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(providers[0]!.connection.prompt).not.toHaveBeenCalled();
  }
);

it('fences dispatcher abort cleanup already awaiting ownership when recovery revokes the launch', async () => {
  const controller = new AbortController();
  await consumer.consumeClaim(h.claim, controller.signal);
  await vi.waitFor(() => expect(providers).toHaveLength(1));
  await providers[0]!.called;
  const lookup = boundary();
  const isOwned = h.session.eventSessionAuthority.isOwned.bind(h.session.eventSessionAuthority);
  vi.spyOn(h.session.eventSessionAuthority, 'isOwned').mockImplementationOnce(async (...args) => {
    const result = await isOwned(...args);
    await lookup.wait();
    return result;
  });
  controller.abort();
  await lookup.entered;
  expect(
    await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
  ).toMatchObject({ status: 'BLOCKED' });
  const invalidate = vi.spyOn(h.session.eventSessionAuthority, 'invalidate');
  lookup.release();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  expect(providers[0]!.child.kill).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect((await row()).status).toBe('RUNNING');
});

it.each([false, true])(
  'joins already-started physical abort cleanup with revoked ownership %s',
  async (revoked) => {
    const controller = new AbortController();
    await consumer.consumeClaim(h.claim, controller.signal);
    await vi.waitFor(() => expect(providers).toHaveLength(1));
    await providers[0]!.called;
    const groups = await vi.importActual<
      typeof import('@/backend/services/session/service/acp/acp-owned-group')
    >('@/backend/services/session/service/acp/acp-owned-group');
    const physical = boundary();
    vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockImplementation(async ({ child }) => {
      await physical.wait();
      child.kill();
      return 'LOCAL_RUNTIME_GROUP_STOPPED';
    });
    const record = vi.spyOn(h.session.eventSessionAuthority, 'recordStop');
    controller.abort();
    await physical.entered;
    const signalsAtGate = providers[0]!.child.kill.mock.calls.length;
    if (revoked) {
      expect(
        await consumer.resolveAmbiguousRun({ ...(await context()), action: 'RETRY' })
      ).toMatchObject({ status: 'BLOCKED' });
    }
    let joined = false;
    const stopping = consumer.stop().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(providers[0]!.child.kill).toHaveBeenCalledTimes(signalsAtGate);
    physical.release();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await stopping;
    expect(providers[0]!.child.kill).toHaveBeenCalledTimes(signalsAtGate + 1);
    if (revoked) {
      expect(record).not.toHaveBeenCalled();
    } else {
      expect(record).toHaveBeenCalledWith(
        h.attempt.sessionId,
        expect.objectContaining({ cause: 'SHUTDOWN', status: 'LOCAL_RUNTIME_GROUP_STOPPED' }),
        expect.any(AbortSignal),
        undefined,
        expect.any(Function)
      );
    }
  }
);

it.each(['RETRY', 'ABANDON'] as const)(
  'rolls back %s when tracked work changes during its final awaited mutation',
  async (action) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    await strictStop();
    const input = await context();
    const transaction = db.prisma.$transaction.bind(db.prisma);
    const gate = boundary();
    vi.spyOn(db.prisma, '$transaction').mockImplementation((operation) =>
      transaction((tx) => {
        const update = tx.agentRun.update.bind(tx.agentRun);
        const delayedUpdate = async (args: Parameters<typeof update>[0]) => {
          const result = await update(args);
          if (
            args.data.reasonCode === 'EXPLICIT_ABANDONMENT' ||
            args.data.attemptGeneration === input.attempt.attemptGeneration + 1
          ) {
            await gate.wait();
          }
          return result;
        };
        // Prisma's generated relation helpers are unused by this awaited-write fixture.
        vi.spyOn(tx.agentRun, 'update').mockImplementation(
          unsafeCoerce<typeof update>(delayedUpdate)
        );
        return operation(tx);
      })
    );
    const recovering = consumer.resolveAmbiguousRun({ ...input, action });
    await gate.entered;
    providers[0]!.update({
      sessionUpdate: 'session_info_update',
      _meta: { jetbrains: { air: { goal: { status: 'active' } } } },
    });
    gate.release();
    expect(await recovering).toMatchObject({
      status: 'BLOCKED',
      reason: 'PROOF_OR_OWNERSHIP_UNAVAILABLE',
    });
    expect((await h.read()).attempt).toEqual(input.attempt);
    expect((await h.read()).evidence?.resolution).toBeUndefined();
    expect((await row()).status).toBe('RUNNING');
  }
);
const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
async function context() {
  const run = await row();
  return {
    projectId: h.workspaceSource.projectId,
    claim: {
      ...h.claim,
      workerGeneration: run.workerGeneration,
      attemptGeneration: run.attemptGeneration,
    },
    attempt: (await h.read()).attempt,
  };
}
async function launch() {
  await consumer.consumeClaim(h.claim, new AbortController().signal);
  await vi.waitFor(() => expect(providers).toHaveLength(1));
  await providers[0]!.called;
}
async function strictStop() {
  const groups = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-owned-group')
  >('@/backend/services/session/service/acp/acp-owned-group');
  vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockImplementation(({ child }) => {
    child.kill();
    return Promise.resolve('LOCAL_RUNTIME_GROUP_STOPPED');
  });
}

it.each([1, 4])(
  'retries a strictly resolved attempt without spending inherited budget %s or changing logical identities',
  async (attemptCount) => {
    await launch();
    const old = providers[0]!;
    old.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    const setupStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.prisma.agentRun.update({
      where: { id: h.claim.runId },
      data: { attemptCount, launchPreparation: { version: 1, state: 'STARTUP', setupStartedAt } },
    });
    const before = await row();
    const input = await context();
    await strictStop();
    const result = await consumer.resolveAmbiguousRun({ ...input, action: 'RETRY' });
    expect(result.status).toBe('RETRIED');
    await vi.waitFor(() => expect(providers).toHaveLength(2));
    await providers[1]!.called;
    const after = await row();
    expect(after).toMatchObject({
      status: 'RUNNING',
      attemptCount,
      attemptGeneration: input.attempt.attemptGeneration + 1,
      reservedWorkspaceId: before.reservedWorkspaceId,
      reservedSessionId: before.reservedSessionId,
      initialMessageId: before.initialMessageId,
      input: before.input,
      effectiveExecution: before.effectiveExecution,
    });
    expect(after.launchPreparation).toMatchObject({ setupStartedAt });
    expect(
      (await db.prisma.agentSession.findUniqueOrThrow({ where: { id: after.reservedSessionId! } }))
        .codexAccountId
    ).toBe(h.execution.codexAccountId);
    expect(providers[1]!.options.provider).toBe('CODEX');
    const fence = await h.read();
    expect(fence.attempt.messageId).not.toBe(input.attempt.messageId);
    expect(fence.attempt.sendAttemptId).not.toBe(input.attempt.sendAttemptId);
    expect(fence.evidence?.resolution).toMatchObject({
      action: 'RETRY',
      attempt: input.attempt,
      outcome: { result: 'COMPLETED' },
      work: { mode: 'STOPPED' },
    });
    expect(fence.evidence?.outcome).toBeUndefined();
    await expect(h.owner.agentInitialDelivery.ambiguous(input.attempt)).rejects.toThrow();
    await expect(
      h.owner.agentInitialDelivery.outcome(input.attempt, {
        source: fence.evidence!.source!,
        result: 'FAILED',
        stopReason: 'end_turn',
      })
    ).rejects.toThrow();
    expect((await row()).status).toBe('RUNNING');
    providers[1]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    await consumer.maintain(new AbortController().signal);
    expect((await row()).status).toBe('COMPLETED');
  }
);
