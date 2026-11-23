import type { SessionStoreRegistry } from './session-store-registry';
import type { SessionStore } from './session-store.types';

/**
 * Provider history fences: the provider identity a store's history belongs to,
 * suspension while a reader must not apply history, and repaired identities.
 */
export class SessionHistoryFences {
  // Successful rollover identities fence delayed DB reads even after an inactive
  // transcript store is evicted. These contain no transcript data.
  private readonly repairedIdentities = new Map<string, string>();

  constructor(private readonly registry: SessionStoreRegistry) {}

  accept(sessionId: string, providerSessionId: string): boolean {
    const repairedIdentity = this.repairedIdentities.get(sessionId);
    if (repairedIdentity && repairedIdentity !== providerSessionId) {
      return false;
    }
    const store = this.registry.getOrCreate(sessionId);
    store.historyProviderSessionId ??= providerSessionId;
    return !store.historySuspended && store.historyProviderSessionId === providerSessionId;
  }

  create(sessionId: string, providerSessionId: string | null): (() => boolean) | null {
    if (providerSessionId === null && this.repairedIdentities.has(sessionId)) {
      return null;
    }
    if (providerSessionId && !this.accept(sessionId, providerSessionId)) {
      return null;
    }
    const store = this.registry.getOrCreate(sessionId);
    const generation = store.historyReadGeneration ?? 0;
    return () =>
      this.registry.isCurrentStore(sessionId, store) &&
      !store.historySuspended &&
      (store.historyProviderSessionId ?? null) === providerSessionId &&
      (store.historyReadGeneration ?? 0) === generation;
  }

  suspend(sessionId: string): () => void {
    const store = this.registry.getOrCreate(sessionId);
    const generation = (store.historyReadGeneration ?? 0) + 1;
    store.historyReadGeneration = generation;
    store.historySuspended = true;
    return () => {
      if (
        this.registry.isCurrentStore(sessionId, store) &&
        store.historyReadGeneration === generation
      ) {
        store.historySuspended = false;
      }
    };
  }

  /** Bind the store to a repaired identity, fencing reads in flight and forgetting its hydration. */
  repair(sessionId: string, providerSessionId: string): SessionStore {
    this.repairedIdentities.set(sessionId, providerSessionId);
    const store = this.registry.getOrCreateActive(sessionId);
    store.historyProviderSessionId = providerSessionId;
    store.historyReadGeneration = (store.historyReadGeneration ?? 0) + 1;
    store.historySuspended = false;
    store.historyHydrated = false;
    store.historyHydrationSource = undefined;
    store.historyHydratedAt = undefined;
    store.historyFile = undefined;
    return store;
  }

  /** Call only after durable deletion; ordinary store eviction must retain the fence. */
  forget(sessionId: string): void {
    this.repairedIdentities.delete(sessionId);
  }

  clear(): void {
    this.repairedIdentities.clear();
  }
}
