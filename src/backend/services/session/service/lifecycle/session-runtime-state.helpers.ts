import type { SessionRuntimeState } from '@/shared/session-runtime';

const STALE_LOADING_RUNTIME_MAX_AGE_MS = 30_000;

export function isStaleLoadingRuntime(runtime: SessionRuntimeState): boolean {
  if (runtime.phase !== 'loading' || runtime.processState === 'alive') {
    return false;
  }

  const updatedAtMs = Date.parse(runtime.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }

  return Date.now() - updatedAtMs > STALE_LOADING_RUNTIME_MAX_AGE_MS;
}
