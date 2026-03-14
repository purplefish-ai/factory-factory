import type { QueuedMessage } from '@/shared/acp-protocol';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import type { SessionStore } from './session-store.types';

const MAX_TRACKED_HISTORY_RETRY_SESSIONS = 1024;

export class SessionStoreRegistry {
  private readonly stores = new Map<string, SessionStore>();
  private readonly nextHistoryRetryAtBySession = new Map<string, number>();

  getOrCreate(sessionId: string): SessionStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        sessionId,
        initialized: false,
        historyHydrated: false,
        transcript: [],
        queue: [],
        pendingInteractiveRequest: null,
        runtime: createInitialSessionRuntimeState(),
        nextOrder: 0,
      };
      this.stores.set(sessionId, store);
    }
    return store;
  }

  clearSession(sessionId: string): void {
    this.nextHistoryRetryAtBySession.delete(sessionId);
    this.stores.delete(sessionId);
  }

  clearAllSessions(): void {
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
}
