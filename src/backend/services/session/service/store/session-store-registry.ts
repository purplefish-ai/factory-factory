import type { QueuedMessage } from '@/shared/acp-protocol';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import type { SessionStore } from './session-store.types';

const MAX_TRACKED_HISTORY_RETRY_SESSIONS = 1024;

export class SessionStoreRegistry {
  private readonly stores = new Map<string, SessionStore>();
  private readonly nextHistoryRetryAtBySession = new Map<string, number>();
  private readonly preservationOnlyStores = new Map<string, SessionStore>();
  private readonly preservedRejectionCleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  getOrCreate(sessionId: string): SessionStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        sessionId,
        initialized: false,
        historyHydrated: false,
        transcript: [],
        transcriptIdToIndex: new Map(),
        queue: [],
        recentRejections: [],
        pendingInteractiveRequest: null,
        runtime: createInitialSessionRuntimeState(),
        nextOrder: 0,
      };
      this.stores.set(sessionId, store);
    } else if (this.preservationOnlyStores.get(sessionId) === store) {
      this.preservationOnlyStores.delete(sessionId);
    }
    return store;
  }

  clearSession(sessionId: string, options?: { preserveRejections?: boolean }): void {
    const rejectionsToPreserve = options?.preserveRejections
      ? this.stores
          .get(sessionId)
          ?.recentRejections.filter((rejection) => rejection.expiresAt > Date.now())
      : undefined;
    this.cancelPreservedRejectionCleanup(sessionId);
    this.preservationOnlyStores.delete(sessionId);
    this.nextHistoryRetryAtBySession.delete(sessionId);
    this.stores.delete(sessionId);
    if (rejectionsToPreserve?.length) {
      const preservedStore = this.getOrCreate(sessionId);
      preservedStore.recentRejections = rejectionsToPreserve;
      this.preservationOnlyStores.set(sessionId, preservedStore);
      this.schedulePreservedRejectionCleanup(sessionId, preservedStore);
    }
  }

  clearAllSessions(): void {
    for (const timer of this.preservedRejectionCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.preservedRejectionCleanupTimers.clear();
    this.preservationOnlyStores.clear();
    this.nextHistoryRetryAtBySession.clear();
    this.stores.clear();
  }

  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    const pending = new Map<string, PendingInteractiveRequest>();
    for (const [sessionId, store] of this.stores.entries()) {
      if (store.pendingInteractiveRequest) {
        pending.set(sessionId, store.pendingInteractiveRequest);
      }
    }
    return pending;
  }

  getQueueLength(sessionId: string): number {
    return this.getOrCreate(sessionId).queue.length;
  }

  getQueueSnapshot(sessionId: string): QueuedMessage[] {
    return [...this.getOrCreate(sessionId).queue];
  }

  setHistoryRetryAt(sessionId: string, retryAt: number): void {
    const now = Date.now();
    this.pruneExpiredHistoryRetryEntries(now);

    if (
      !this.nextHistoryRetryAtBySession.has(sessionId) &&
      this.nextHistoryRetryAtBySession.size >= MAX_TRACKED_HISTORY_RETRY_SESSIONS
    ) {
      this.evictHistoryRetryEntryWithEarliestRetryAt();
    }

    this.nextHistoryRetryAtBySession.set(sessionId, retryAt);
  }

  canAttemptHistoryHydration(sessionId: string): boolean {
    const now = Date.now();
    this.pruneExpiredHistoryRetryEntries(now);

    const retryAt = this.nextHistoryRetryAtBySession.get(sessionId);
    if (retryAt === undefined) {
      return true;
    }

    return retryAt <= now;
  }

  clearHistoryRetryCooldown(sessionId: string): void {
    this.nextHistoryRetryAtBySession.delete(sessionId);
  }

  private pruneExpiredHistoryRetryEntries(now: number): void {
    for (const [trackedSessionId, retryAt] of this.nextHistoryRetryAtBySession) {
      if (retryAt <= now) {
        this.nextHistoryRetryAtBySession.delete(trackedSessionId);
      }
    }
  }

  private evictHistoryRetryEntryWithEarliestRetryAt(): void {
    let sessionIdToEvict: string | undefined;
    let earliestRetryAt = Number.POSITIVE_INFINITY;

    for (const [trackedSessionId, retryAt] of this.nextHistoryRetryAtBySession) {
      if (retryAt < earliestRetryAt) {
        earliestRetryAt = retryAt;
        sessionIdToEvict = trackedSessionId;
      }
    }

    if (sessionIdToEvict) {
      this.nextHistoryRetryAtBySession.delete(sessionIdToEvict);
    }
  }

  private cancelPreservedRejectionCleanup(sessionId: string): void {
    const timer = this.preservedRejectionCleanupTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.preservedRejectionCleanupTimers.delete(sessionId);
    }
  }

  private schedulePreservedRejectionCleanup(sessionId: string, store: SessionStore): void {
    const nextExpiration = Math.min(
      ...store.recentRejections.map((rejection) => rejection.expiresAt)
    );
    const timer = setTimeout(
      () => {
        this.preservedRejectionCleanupTimers.delete(sessionId);
        if (this.stores.get(sessionId) !== store) {
          if (this.preservationOnlyStores.get(sessionId) === store) {
            this.preservationOnlyStores.delete(sessionId);
          }
          return;
        }

        store.recentRejections = store.recentRejections.filter(
          (rejection) => rejection.expiresAt > Date.now()
        );
        if (store.recentRejections.length > 0) {
          this.schedulePreservedRejectionCleanup(sessionId, store);
          return;
        }
        if (this.preservationOnlyStores.get(sessionId) === store) {
          this.preservationOnlyStores.delete(sessionId);
          this.stores.delete(sessionId);
        }
      },
      Math.max(0, nextExpiration - Date.now())
    );
    timer.unref();
    this.preservedRejectionCleanupTimers.set(sessionId, timer);
  }
}
