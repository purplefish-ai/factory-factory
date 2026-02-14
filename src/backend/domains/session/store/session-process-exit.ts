import type { SessionStore, SnapshotReason } from './session-store.types';

export function handleProcessExit(options: {
  store: SessionStore;
  code: number | null;
  nowIso: () => string;
  markRuntime: (
    store: SessionStore,
    updates: {
      phase: 'error' | 'idle';
      processState: 'stopped';
      activity: 'IDLE';
      lastExit: { code: number | null; timestamp: string; unexpected: boolean };
    }
  ) => void;
  forwardSnapshot: (
    store: SessionStore,
    options: { reason: SnapshotReason; includeParitySnapshot: boolean }
  ) => void;
}): void {
  const { store, code, nowIso, markRuntime, forwardSnapshot } = options;
  const unexpected = code === null || code !== 0;

  store.queue = [];
  store.pendingInteractiveRequest = null;
  store.transcript = [];
  store.nextOrder = 0;
  store.initialized = false;

  markRuntime(store, {
    phase: unexpected ? 'error' : 'idle',
    processState: 'stopped',
    activity: 'IDLE',
    lastExit: {
      code,
      timestamp: nowIso(),
      unexpected,
    },
  });

  forwardSnapshot(store, {
    reason: 'process_exit_reset',
    includeParitySnapshot: true,
  });
}
