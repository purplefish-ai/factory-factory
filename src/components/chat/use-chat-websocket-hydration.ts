export type HydrationBatch = { loadRequestId?: string; type?: string };
export type HydrationBatchDecision = 'pass' | 'drop' | 'match';
export const CONNECT_LOADING_DEBOUNCE_MS = 300;

export function parseHydrationBatch(data: unknown): HydrationBatch | null {
  if (typeof data !== 'object' || data === null || !('type' in data)) {
    return null;
  }

  const maybeType = (data as { type?: string }).type;
  if (maybeType !== 'session_replay_batch' && maybeType !== 'session_snapshot') {
    return null;
  }

  return data as HydrationBatch;
}

export function evaluateHydrationBatch(
  batch: HydrationBatch,
  pendingLoadRequestId: string | null
): HydrationBatchDecision {
  if (pendingLoadRequestId) {
    if (!batch.loadRequestId) {
      return 'drop';
    }
    return batch.loadRequestId === pendingLoadRequestId ? 'match' : 'drop';
  }

  return batch.loadRequestId ? 'drop' : 'pass';
}

export function shouldScheduleConnectLoading(hasHydratedSession: boolean): boolean {
  return !hasHydratedSession;
}

export function scheduleConnectLoadingStart(options: {
  hasHydratedSession: boolean;
  onLoadingStart: () => void;
  debounceMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): () => void {
  const {
    hasHydratedSession,
    onLoadingStart,
    debounceMs = CONNECT_LOADING_DEBOUNCE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  if (!shouldScheduleConnectLoading(hasHydratedSession)) {
    return () => undefined;
  }

  const timeout = setTimeoutFn(onLoadingStart, debounceMs);
  return () => {
    clearTimeoutFn(timeout);
  };
}
