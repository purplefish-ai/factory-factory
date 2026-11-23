import type { SessionStoreRegistry } from './session-store-registry';
import type { HistoryFileIdentity } from './session-store.types';

/** How long an idle session's store outlives its last viewer. */
export const SESSION_STORE_RETENTION_GRACE_MS = 10 * 60_000;
/** Idle stores kept at once; one more clears the one released longest ago. */
export const MAX_RETAINED_SESSION_STORES = 12;

export interface RetainedStoreClaim {
  /** The history file the store was hydrated from; absent when the read could not identify it. */
  readonly historyFile: HistoryFileIdentity | undefined;
  /** Clear the claimed store, unless it has been replaced since. */
  discard(): void;
}

type Retained = { timer: ReturnType<typeof setTimeout>; isIdle: () => boolean };

/**
 * Keeps a hydrated store for a grace period after its last viewer leaves, so a
 * viewer that comes back replays it instead of rebuilding it from provider
 * history (which renumbers rows). Every clear goes through `clear`, the session
 * domain's `clearSession`; a load or any write that activates the store ends
 * its countdown. Why and the numbers:
 * docs/decisions/2026-11-23-idle-session-stores-outlive-their-last-viewer.md.
 */
export class SessionStoreRetention {
  /** In release order, oldest first. */
  private readonly retained = new Map<string, Retained>();
  private stopped = false;

  constructor(
    private readonly registry: Pick<SessionStoreRegistry, 'getExisting' | 'isCurrentStore'>,
    private readonly clear: (sessionId: string) => void,
    private readonly limits = {
      graceMs: SESSION_STORE_RETENTION_GRACE_MS,
      maxRetained: MAX_RETAINED_SESSION_STORES,
    }
  ) {}

  /**
   * The last viewer left a session without a running runtime. `isIdle` is asked
   * again before the store is cleared; a store in use by then is left to the
   * owner of that use. A store that never finished hydrating is cleared now.
   */
  release(sessionId: string, isIdle: () => boolean): void {
    this.cancel(sessionId);
    if (this.stopped || !this.registry.getExisting(sessionId)?.historyHydrated) {
      this.clear(sessionId);
      return;
    }
    const timer = setTimeout(() => this.expire(sessionId), this.limits.graceMs);
    timer.unref();
    this.retained.set(sessionId, { timer, isIdle });
    for (const oldest of this.retained.keys()) {
      if (this.retained.size <= this.limits.maxRetained) {
        break;
      }
      this.expire(oldest);
    }
  }

  /** Stops the countdown. Returns whether the session was retained. */
  cancel(sessionId: string): boolean {
    const entry = this.retained.get(sessionId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.retained.delete(sessionId);
    return true;
  }

  /**
   * A load begins: stop the countdown. Returns a claim when the store came from
   * a provider history file, so the loader can check that file is unchanged.
   */
  claim(sessionId: string): RetainedStoreClaim | undefined {
    if (!this.cancel(sessionId)) {
      return undefined;
    }
    const store = this.registry.getExisting(sessionId);
    if (store?.historyHydrationSource !== 'jsonl') {
      return undefined;
    }
    return {
      historyFile: store.historyFile,
      discard: () => {
        if (this.registry.isCurrentStore(sessionId, store)) {
          this.clear(sessionId);
        }
      },
    };
  }

  cancelAll(): void {
    for (const sessionId of [...this.retained.keys()]) {
      this.cancel(sessionId);
    }
  }

  /** Shutdown: clear every retained store now, and any released later at once. */
  stop(): void {
    this.stopped = true;
    for (const sessionId of [...this.retained.keys()]) {
      this.cancel(sessionId);
      this.clear(sessionId);
    }
  }

  private expire(sessionId: string): void {
    const entry = this.retained.get(sessionId);
    if (entry && this.cancel(sessionId) && entry.isIdle()) {
      this.clear(sessionId);
    }
  }
}
