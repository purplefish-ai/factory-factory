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
  ensureHydrated: (
    store: SessionStore,
    options: { claudeSessionId: string | null; claudeProjectPath: string | null }
  ) => Promise<void>;
  onRehydrateError: (error: unknown) => void;
}): void {
  const { store, code, nowIso, markRuntime, forwardSnapshot, ensureHydrated, onRehydrateError } =
    options;
  const unexpected = code === null || code !== 0;

  store.queue = [];
  store.pendingInteractiveRequest = null;
  store.transcript = [];
  store.nextOrder = 0;
  store.initialized = false;
  store.hydratedKey = null;
  store.hydrateGeneration += 1;
  store.hydratePromise = null;

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

  const { lastKnownClaudeSessionId, lastKnownProjectPath } = store;
  if (lastKnownClaudeSessionId && lastKnownProjectPath) {
    void ensureHydrated(store, {
      claudeSessionId: lastKnownClaudeSessionId,
      claudeProjectPath: lastKnownProjectPath,
    })
      .then(() => {
        forwardSnapshot(store, {
          reason: 'process_exit_rehydrate',
          includeParitySnapshot: true,
        });
      })
      .catch((error) => {
        onRehydrateError(error);
      });
  }
}
