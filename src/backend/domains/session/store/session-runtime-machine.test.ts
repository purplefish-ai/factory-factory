import { describe, expect, it, vi } from 'vitest';
import { SessionRuntimeMachine } from './session-runtime-machine';
import type { SessionStore } from './session-store.types';

function createStore(): SessionStore {
  return {
    sessionId: 's1',
    initialized: true,
    transcript: [],
    queue: [],
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
});
