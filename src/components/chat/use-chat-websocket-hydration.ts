export type HydrationBatch = { loadRequestId?: string; type?: string };
export type HydrationBatchDecision = 'pass' | 'drop' | 'match';

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
