import type { QueuedMessage } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import type { SessionStore } from './session-store.types';

export class SessionStoreRegistry {
  private readonly stores = new Map<string, SessionStore>();

  getOrCreate(sessionId: string): SessionStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        sessionId,
        initialized: false,
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
    this.stores.delete(sessionId);
  }

  clearAllSessions(): void {
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
}
