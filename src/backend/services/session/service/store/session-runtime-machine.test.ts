import { describe, expect, it, vi } from 'vitest';
import type { SessionWorkState } from '@/shared/session-runtime';
import { SessionRuntimeMachine } from './session-runtime-machine';
import type { SessionStore } from './session-store.types';

function createStore(): SessionStore {
  return {
    sessionId: 's1',
    initialized: true,
    transcript: [],
    transcriptIdToIndex: new Map(),
    queue: [],
    recentRejections: [],
    pendingInteractiveRequest: null,
    runtime: {
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      lastExit: {
        code: 1,
        timestamp: '2026-02-01T00:00:00.000Z',
        unexpected: true,
      },
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    nextOrder: 0,
  };
}

describe('SessionRuntimeMachine', () => {
  const work: SessionWorkState = {
    promptInFlight: false,
    backgroundTasks: [{ id: 'preview', name: 'pnpm storybook', kind: 'shell' }],
    runningSubagents: 0,
    activeGoals: 0,
  };

  it('retains explicit work when restoring an alive idle snapshot', () => {
    const machine = new SessionRuntimeMachine(
      () => undefined,
      () => '2026-02-09T00:00:00.000Z'
    );
    const store = createStore();
    machine.markRuntime(
      store,
      { phase: 'idle', processState: 'alive', activity: 'IDLE', work },
      { replace: true }
    );
    expect(store.runtime.work).toEqual(work);
  });

  it('clears cached work for the alive working error payload produced by markError', () => {
    const machine = new SessionRuntimeMachine(
      () => undefined,
      () => '2026-02-09T00:00:00.000Z'
    );
    const store = createStore();
    machine.markRuntime(store, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      work,
    });
    machine.markRuntime(store, {
      phase: 'error',
      processState: 'alive',
      activity: 'WORKING',
      errorMessage: 'Provider failed',
    });
    expect(store.runtime.work).toBeUndefined();
    expect(store.runtime.errorMessage).toBe('Provider failed');
  });

  it('honors an explicit clear without restoring cached work', () => {
    const machine = new SessionRuntimeMachine(
      () => undefined,
      () => '2026-02-09T00:00:00.000Z'
    );
    const store = createStore();
    machine.markRuntime(store, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      work,
    });
    machine.markRuntime(store, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      work: undefined,
    });
    expect(store.runtime.work).toBeUndefined();
  });

  it.each(['idle', 'stopping'] as const)('clears prior work when moving to %s', (phase) => {
    const machine = new SessionRuntimeMachine(
      () => undefined,
      () => '2026-02-09T00:00:00.000Z'
    );
    const store = createStore();
    machine.markRuntime(store, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      work: {
        promptInFlight: false,
        backgroundTasks: [{ id: 'preview', name: 'pnpm storybook', kind: 'shell' }],
        runningSubagents: 0,
        activeGoals: 0,
      },
    });
    machine.markRuntime(store, { phase, processState: 'stopped', activity: 'IDLE' });
    expect(store.runtime.work).toBeUndefined();
  });

  it('replaces runtime snapshot and emits delta by default', () => {
    const emitRuntimeDelta = vi.fn();
    const machine = new SessionRuntimeMachine(emitRuntimeDelta, () => '2026-02-09T00:00:00.000Z');
    const store = createStore();

    machine.markRuntime(
      store,
      {
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
      },
      { replace: true }
    );

    expect(store.runtime).toMatchObject({
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: '2026-02-09T00:00:00.000Z',
    });
    expect(store.runtime.lastExit).toBeUndefined();
    expect(emitRuntimeDelta).toHaveBeenCalledWith('s1', store.runtime);
  });

  it('clears stale lastExit when transitioning without explicit lastExit', () => {
    const emitRuntimeDelta = vi.fn();
    const machine = new SessionRuntimeMachine(emitRuntimeDelta, () => '2026-02-09T00:00:00.000Z');
    const store = createStore();

    machine.markRuntime(store, {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
    });

    expect(store.runtime.lastExit).toBeUndefined();
    expect(Object.hasOwn(store.runtime, 'lastExit')).toBe(false);
    expect(store.runtime.updatedAt).toBe('2026-02-09T00:00:00.000Z');
    expect(emitRuntimeDelta).toHaveBeenCalledTimes(1);
  });

  it('clears stale errorMessage when transitioning without explicit errorMessage', () => {
    const emitRuntimeDelta = vi.fn();
    const machine = new SessionRuntimeMachine(emitRuntimeDelta, () => '2026-02-09T00:00:00.000Z');
    const store = createStore();
    store.runtime.errorMessage = 'Failed to start agent';

    machine.markRuntime(store, {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
    });

    expect(store.runtime.errorMessage).toBeUndefined();
    expect(Object.hasOwn(store.runtime, 'errorMessage')).toBe(false);
  });
});
