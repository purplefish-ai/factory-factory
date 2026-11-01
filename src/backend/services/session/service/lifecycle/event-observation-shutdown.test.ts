import { afterEach, expect, it, vi } from 'vitest';
import { AcpRuntimeQuiescence } from '@/backend/services/session/service/acp/acp-runtime-quiescence';
import type { InitialDeliveryFence, RuntimeStopEvidence } from '@/shared/event-agent-delivery';
import { EventSessionAuthority } from './event-session-authority';
import { createDeferred, createTerminationHarness } from './session-lifecycle.test-helpers';
import { SessionTerminationCoordinator } from './session-termination.coordinator';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function harness() {
  const state: InitialDeliveryFence = {
    attempt: {
      runId: 'run',
      sessionId: 'reserved',
      messageId: 'message',
      sendAttemptId: 'send',
      workerGeneration: 1,
      attemptGeneration: 1,
    },
    state: 'SENDING',
    execution: {
      version: 1,
      provider: 'CLAUDE',
      model: 'sonnet',
      reasoningEffort: null,
      codexAccountId: null,
      startupModePreset: 'non_interactive',
      accessMode: 'bypassPermissions',
      planModeEnabled: false,
    },
    evidence: null,
  };
  const source = {
    version: 1 as const,
    provider: 'CLAUDE' as const,
    providerSessionId: 'native',
    runtimeIncarnationId: 'runtime',
    lifecycleGeneration: 1,
  };
  state.evidence = { version: 1, attempt: state.attempt, source };
  const stop: RuntimeStopEvidence = {
    version: 1,
    cause: 'SHUTDOWN',
    status: 'LOCAL_RUNTIME_GROUP_STOPPED',
    source,
    observedAt: new Date().toISOString(),
  };
  const owner = {
    readFence: vi.fn(async () => state),
    beforeSend: vi.fn(async () => undefined),
    outcome: vi.fn(async () => undefined),
    ambiguous: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const authority = new EventSessionAuthority(async () => ({
    runId: 'run',
    execution: state.execution,
  }));
  authority.configure(owner);
  const base = createTerminationHarness();
  const runtimeManager = {
    ...base.runtimeManager,
    beginShutdown: vi.fn(() => ['reserved']),
    stopAndQuiesceObserved: vi.fn((_id: string) => Promise.resolve(stop)),
    stopAllClients: vi.fn(async () => undefined),
  };
  const coordinator = new SessionTerminationCoordinator({
    ...base,
    runtimeManager,
    eventAuthority: authority,
  });
  return { authority, owner, state, stop, runtimeManager, coordinator };
}
it('tracks the complete stop observation, including the durable fence read, until drain finishes', async () => {
  const h = harness();
  const read = createDeferred<InitialDeliveryFence>();
  h.owner.readFence.mockReturnValueOnce(read.promise);
  const observed = h.authority.recordStop('reserved', h.stop);
  let drained = false;
  const drain = h.authority.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(drained).toBe(false);
  read.resolve(h.state);
  await observed;
  await drain;
  expect(h.owner.stop).toHaveBeenCalledOnce();
  expect(h.owner.ambiguous).toHaveBeenCalledOnce();
});
it.each(['stop-read', 'stop-write', 'exit-read'] as const)(
  'starts no new owner writes after timed-out shutdown with a deferred %s',
  async (boundary) => {
    vi.useFakeTimers();
    const h = harness();
    const read = createDeferred<InitialDeliveryFence>();
    const write = createDeferred<undefined>();
    let exit: Promise<unknown> | undefined;
    if (boundary === 'stop-read') {
      h.owner.readFence.mockResolvedValueOnce(h.state).mockReturnValueOnce(read.promise);
    }
    if (boundary === 'stop-write') {
      h.owner.stop.mockReturnValueOnce(write.promise);
    }
    if (boundary === 'exit-read') {
      h.owner.readFence.mockReturnValueOnce(read.promise);
      h.runtimeManager.beginShutdown.mockReturnValue([]);
      exit = h.authority
        .observeUnexpectedExit('reserved', 'runtime')
        .catch((error: unknown) => error);
    }
    let result: unknown = 'pending';
    const shutdown = h.coordinator.stopAllClients().then(
      () => {
        result = 'success';
      },
      (error: unknown) => {
        result = error;
      }
    );
    await vi.advanceTimersByTimeAsync(20_001);
    expect(result).toBeInstanceOf(Error);
    expect(h.runtimeManager.stopAllClients).toHaveBeenCalledOnce();
    const writesStarted = h.owner.stop.mock.calls.length;
    read.resolve(h.state);
    write.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    await shutdown;
    await exit;
    expect(h.owner.stop).toHaveBeenCalledTimes(writesStarted);
    expect(h.owner.ambiguous).not.toHaveBeenCalled();
    await expect(h.authority.recordStop('reserved', h.stop)).rejects.toThrow();
    expect(h.owner.stop).toHaveBeenCalledTimes(writesStarted);
  }
);

it('moves on to remaining sessions and global cleanup when a registered creation never drains', async () => {
  vi.useFakeTimers();
  const h = harness();
  const quiescence = new AcpRuntimeQuiescence({ stopClient: async () => undefined });
  const pendingRead = createDeferred<void>();
  const creation = quiescence.runClientCreationOperation(
    'reserved',
    'active',
    () => pendingRead.promise
  );
  h.runtimeManager.beginShutdown.mockReturnValue(['reserved', 'second']);
  h.runtimeManager.stopAndQuiesceObserved.mockImplementation((id: string) =>
    quiescence.runObservedStop(id, async () => h.stop).then((stops) => stops[0]!)
  );
  let result: unknown = 'pending';
  const shutdown = h.coordinator.stopAllClients().then(
    () => {
      result = 'success';
    },
    (error: unknown) => {
      result = error;
    }
  );
  try {
    await vi.advanceTimersByTimeAsync(20_001);
    expect(result).toBeInstanceOf(Error);
    expect(h.runtimeManager.stopAndQuiesceObserved.mock.calls.map(([id]) => id)).toEqual([
      'reserved',
      'second',
    ]);
    expect(h.owner.stop).toHaveBeenCalledWith(
      h.state.attempt,
      expect.objectContaining({ status: 'UNKNOWN', cause: 'SHUTDOWN' })
    );
    expect(h.runtimeManager.stopAllClients).toHaveBeenCalledOnce();
    await expect(
      quiescence.runClientCreationOperation('reserved', 'active', async () => undefined)
    ).rejects.toThrow();
  } finally {
    pendingRead.resolve();
    await creation;
    await shutdown;
  }
});
