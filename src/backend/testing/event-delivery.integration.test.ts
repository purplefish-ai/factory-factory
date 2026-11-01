import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  boundary,
  createEventDeliveryFixture,
  drainEventFixtureTasks,
  releaseEventBoundaries,
} from '@/backend/orchestration/testing/event-delivery.test-support';
import { fakeEventProvider } from '@/backend/orchestration/testing/event-provider.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let fixture: Awaited<ReturnType<typeof createEventDeliveryFixture>> | undefined;
const providers = new Map<string, ReturnType<typeof fakeEventProvider>>();
const sends: string[] = [];
let beforePrompt: (sessionId: string) => Promise<void>;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  fixture = undefined;
  providers.clear();
  sends.length = 0;
  beforePrompt = async (id) => {
    const delivery = await db.prisma.agentInitialDelivery.findFirstOrThrow({
      where: { run: { reservedSessionId: id } },
    });
    // Witness inside the actual provider invocation, not a later read after it returns.
    expect(delivery.state).toBe('SENDING');
    sends.push(id);
  };
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('Host process signalling forbidden');
  });
  const factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  const session = await vi.importActual<typeof import('@/backend/services/session')>(
    '@/backend/services/session'
  );
  const accounts = await vi.importActual<typeof import('@/backend/services/codex-accounts')>(
    '@/backend/services/codex-accounts'
  );
  vi.spyOn(accounts.codexAccountService, 'getEnabledAccountIds').mockResolvedValue([
    'codex-native-default',
    'event-test-account',
  ]);
  vi.spyOn(accounts.codexAccountService, 'getRuntimeContext').mockImplementation(
    async (id = 'codex-native-default') => ({
      accountId: id,
      homeDir: db.tempDir,
      sessionsDir: db.tempDir,
      env: {},
    })
  );
  vi.spyOn(factory.AcpClientFactory.prototype, 'createClient').mockImplementation(({ options }) => {
    const provider = fakeEventProvider(session.AcpProcessHandle, options, () =>
      beforePrompt(options.sessionId)
    );
    providers.set(options.sessionId, provider);
    return Promise.resolve(provider.handle);
  });
}, 30_000);
afterEach(async () => {
  releaseEventBoundaries();
  for (const provider of providers.values()) {
    provider.response.resolve({ stopReason: 'end_turn' });
  }
  await drainEventFixtureTasks();
  // No fake host PID/group: UNKNOWN is the honest teardown result, not local-group proof.
  await fixture?.session.acpRuntimeManager
    .stopAllClients(10)
    .catch((error: unknown) =>
      expect(error).toMatchObject({ message: 'Event runtime stop is unconfirmed' })
    );
  fixture?.session.sessionPromptTurnCompletionService.clearAll();
  fixture?.session.sessionDomainService.clearAllSessions();
  expect(process.kill).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await destroyIntegrationDatabase(db);
});
async function setup(provider: 'CLAUDE' | 'CODEX' = 'CLAUDE') {
  fixture = await createEventDeliveryFixture(db, provider);
  return fixture;
}
async function waitForSend(id: string) {
  await vi.waitFor(() => expect(sends).toContain(id));
  return providers.get(id)!;
}

it.each(['CLAUDE', 'CODEX'] as const)(
  'pins $0 execution and reserved identities through real startup, SENDING and terminal persistence',
  async (kind) => {
    const h = await setup(kind);
    await h.creation.createEventWorkspaceOnce(h.workspaceSource);
    await h.session.sessionDataService.createEventSessionOnce({
      id: h.attempt.sessionId,
      workspaceId: h.claim.reservedWorkspaceId,
      runId: h.claim.runId,
      execution: h.execution,
    });
    expect(await db.prisma.workspace.count()).toBe(1);
    expect(await db.prisma.agentSession.count()).toBe(1);
    const task = h.dispatch();
    const provider = await waitForSend(h.attempt.sessionId);
    if (kind === 'CODEX') {
      expect(provider.options.codexAccountContext?.accountId).toBe('event-test-account');
    }
    expect(await h.read()).toMatchObject({
      state: 'SENDING',
      attempt: h.attempt,
      execution: h.execution,
    });
    expect(provider.connection.prompt).toHaveBeenCalledWith({
      sessionId: provider.handle.acpSessionId,
      prompt: [{ type: 'text', text: 'Frozen task' }],
    });
    expect(provider.handle.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'model', currentValue: h.execution.model }),
        expect.objectContaining({ id: 'reasoning_effort', currentValue: 'high' }),
        expect.objectContaining({ id: 'mode', currentValue: h.execution.accessMode }),
        expect.objectContaining({ id: 'collaboration_mode', currentValue: 'default' }),
      ])
    );
    expect(
      await db.prisma.agentSession.findUnique({ where: { id: h.attempt.sessionId } })
    ).toMatchObject({
      codexAccountId: h.execution.codexAccountId,
      providerSessionId: provider.handle.providerSessionId,
    });
    provider.response.resolve({ stopReason: 'end_turn' });
    await task;
    expect(await h.read()).toMatchObject({
      state: 'FINISHED',
      evidence: { outcome: { result: 'COMPLETED' } },
    });
    expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
      status: 'RUNNING',
      launchPhase: 'ACTIVE',
    });
  }
);
it('cancellation after SENDING commits but before its await returns prevents provider invocation', async () => {
  const h = await setup();
  const writing = boundary();
  h.session.eventSessionAuthority.configure({
    ...h.owner.agentInitialDelivery,
    beforeSend: async (...args) => {
      await h.owner.agentInitialDelivery.beforeSend(...args);
      await writing.wait();
    },
  });
  const task = h.dispatch().catch((error: unknown) => error);
  await writing.entered;
  expect(await h.read()).toMatchObject({ state: 'SENDING' });
  expect(await h.session.acpRuntimeManager.cancelPrompt(h.attempt.sessionId)).toBe(true);
  writing.release();
  expect(await task).toMatchObject({ message: 'Prompt cancelled before send' });
  expect(providers.get(h.attempt.sessionId)!.connection.prompt).not.toHaveBeenCalled();
  expect(await h.read()).toMatchObject({ state: 'AMBIGUOUS' });
  await expect(h.dispatch()).rejects.toThrow(/fenced/i);
  expect(sends).toEqual([]);
});
it('retains the active initial fence through the actual terminal owner commit', async () => {
  const h = await setup();
  const committing = boundary();
  const committed = boundary();
  h.session.eventSessionAuthority.configure({
    ...h.owner.agentInitialDelivery,
    outcome: async (...args) => {
      await committing.wait();
      await h.owner.agentInitialDelivery.outcome(...args);
      await committed.wait();
    },
  });
  const task = h.dispatch();
  const provider = await waitForSend(h.attempt.sessionId);
  provider.response.resolve({ stopReason: 'end_turn' });
  await committing.entered;
  expect(await h.read()).toMatchObject({ state: 'SENDING' });
  await expect(h.session.eventSessionAuthority.assertOrdinary(h.attempt.sessionId)).rejects.toThrow(
    /fenced/i
  );
  committing.release();
  await committed.entered;
  expect(await h.read()).toMatchObject({ state: 'FINISHED' });
  await expect(h.session.eventSessionAuthority.assertOrdinary(h.attempt.sessionId)).rejects.toThrow(
    /fenced/i
  );
  committed.release();
  await task;
  await expect(
    h.session.eventSessionAuthority.assertOrdinary(h.attempt.sessionId)
  ).resolves.toBeUndefined();
});
it('retains UNKNOWN stop evidence and never resends an inconclusive provider request', async () => {
  const h = await setup();
  const task = h.dispatch().catch((error: unknown) => error);
  const provider = await waitForSend(h.attempt.sessionId);
  provider.response.reject(new Error('Transport disconnected'));
  expect(await task).toMatchObject({ message: 'Transport disconnected' });
  await expect(h.session.sessionLifecycleService.stopSession(h.attempt.sessionId)).rejects.toThrow(
    /unconfirmed/i
  );
  expect(await h.read()).toMatchObject({
    state: 'AMBIGUOUS',
    evidence: { stop: { status: 'UNKNOWN' } },
  });
  await expect(h.dispatch()).rejects.toThrow(/fenced/i);
  expect(provider.connection.prompt).toHaveBeenCalledOnce();
});
it('pre-send transaction failure prevents transport invocation at the actual owner write', async () => {
  const h = await setup();
  await db.prisma.$executeRawUnsafe(
    "CREATE TRIGGER reject_sending BEFORE UPDATE OF state ON AgentInitialDelivery WHEN NEW.state = 'SENDING' BEGIN SELECT RAISE(ABORT, 'injected sending failure'); END"
  );
  await expect(h.dispatch()).rejects.toThrow();
  expect(providers.has(h.attempt.sessionId)).toBe(true);
  expect(providers.get(h.attempt.sessionId)!.handle.configOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'reasoning_effort', currentValue: 'high' }),
    ])
  );
  expect(providers.get(h.attempt.sessionId)!.connection.prompt).not.toHaveBeenCalled();
  expect(await h.read()).toMatchObject({ state: 'PENDING', evidence: null });
});
it('progresses another session while the first real initial prompt remains in flight', async () => {
  const first = await setup();
  const second = await createEventDeliveryFixture(db);
  const task1 = first.dispatch();
  const p1 = await waitForSend(first.attempt.sessionId);
  const task2 = second.dispatch();
  const p2 = await waitForSend(second.attempt.sessionId);
  expect(await first.read()).toMatchObject({ state: 'SENDING' });
  expect(await second.read()).toMatchObject({ state: 'SENDING' });
  p2.response.resolve({ stopReason: 'end_turn' });
  await task2;
  expect(await first.read()).toMatchObject({ state: 'SENDING' });
  p1.response.resolve({ stopReason: 'end_turn' });
  await task1;
});
it('bounds shutdown of a registered stalled startup and still cleans another real runtime', async () => {
  const h = await setup();
  const second = await createEventDeliveryFixture(db);
  const task2 = second.dispatch();
  const p2 = await waitForSend(second.attempt.sessionId);
  p2.response.resolve({ stopReason: 'end_turn' });
  await task2;
  const reading = boundary();
  let held = false;
  h.session.eventSessionAuthority.configure({
    ...h.owner.agentInitialDelivery,
    readFence: async (runId, sessionId) => {
      if (
        !held &&
        sessionId === h.attempt.sessionId &&
        h.session.acpRuntimeManager.hasClientCreationOperation(sessionId)
      ) {
        held = true;
        await reading.wait();
      }
      return h.owner.agentInitialDelivery.readFence(runId, sessionId);
    },
  });
  const startup = h.dispatch().catch((error: unknown) => error);
  await reading.entered;
  expect(h.session.acpRuntimeManager.hasClientCreationOperation(h.attempt.sessionId)).toBe(true);
  expect(providers.has(h.attempt.sessionId)).toBe(false);
  vi.useFakeTimers();
  const shutdown = h.session.sessionLifecycleService
    .stopAllClients(10)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(25_001);
  expect(await shutdown).toBeInstanceOf(Error);
  expect(p2.child.kill).toHaveBeenCalled();
  reading.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(await startup).toBeInstanceOf(Error);
  expect(providers.has(h.attempt.sessionId)).toBe(false);
  expect(await h.read()).toMatchObject({ state: 'PENDING' });
});
it('closes a stalled stop-observation read before it can start a late durable write', async () => {
  const h = await setup();
  const task = h.dispatch();
  const p = await waitForSend(h.attempt.sessionId);
  p.response.resolve({ stopReason: 'end_turn' });
  await task;
  const reading = boundary();
  let reads = 0;
  const stops = vi.fn(h.owner.agentInitialDelivery.stop);
  const ambiguous = vi.fn(h.owner.agentInitialDelivery.ambiguous);
  h.session.eventSessionAuthority.configure({
    ...h.owner.agentInitialDelivery,
    stop: stops,
    ambiguous,
    readFence: async (...args) => {
      if (++reads === 2) {
        await reading.wait();
      }
      return h.owner.agentInitialDelivery.readFence(...args);
    },
  });
  vi.useFakeTimers();
  const shutdown = h.session.sessionLifecycleService
    .stopAllClients(10)
    .catch((error: unknown) => error);
  await reading.entered;
  expect(p.child.kill).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(25_001);
  expect(await shutdown).toBeInstanceOf(Error);
  expect(stops).not.toHaveBeenCalled();
  reading.release();
  await vi.advanceTimersByTimeAsync(0);
  await expect(
    h.session.eventSessionAuthority.recordStop(h.attempt.sessionId, {
      version: 1,
      cause: 'SHUTDOWN',
      source: null,
      status: 'UNKNOWN',
      observedAt: new Date().toISOString(),
    })
  ).rejects.toThrow(/closed/i);
  expect(stops).not.toHaveBeenCalled();
  expect(ambiguous).not.toHaveBeenCalled();
});
it('holds real human queue settings and ignores a second IDLE chat during the initial singleton', async () => {
  const h = await setup();
  const extra = await h.session.sessionDataService.createAgentSession({
    workspaceId: h.claim.reservedWorkspaceId,
    workflow: 'followup',
    provider: 'CLAUDE',
    model: 'sonnet',
  });
  const queued = {
    id: 'human-followup',
    timestamp: new Date().toISOString(),
    text: 'Human task',
    settings: {
      selectedModel: 'opus',
      reasoningEffort: 'low',
      thinkingEnabled: false,
      planModeEnabled: true,
    },
  };
  h.session.sessionDomainService.enqueue(h.attempt.sessionId, queued);
  await h.session.sessionDispatchService.tryDispatchNextMessage(h.attempt.sessionId);
  expect(providers.size).toBe(0);
  const task = h.dispatch();
  const provider = await waitForSend(h.attempt.sessionId);
  expect(providers.has(extra.id)).toBe(false);
  expect(provider.connection.prompt).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: [{ type: 'text', text: 'Frozen task' }] })
  );
  expect(h.session.sessionDomainService.getQueueSnapshot(h.attempt.sessionId)).toEqual([
    expect.objectContaining(queued),
  ]);
  provider.response.resolve({ stopReason: 'end_turn' });
  await task;
  expect(h.session.sessionDomainService.getQueueSnapshot(h.attempt.sessionId)).toEqual([
    expect.objectContaining(queued),
  ]);
});
