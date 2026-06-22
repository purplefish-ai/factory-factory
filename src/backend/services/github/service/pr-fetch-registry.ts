/**
 * PR Fetch Registry
 *
 * In-memory registry tracking when a GitHub PR fetch was last performed per workspace.
 * Used to deduplicate concurrent background polling between the scheduler and ratchet,
 * which both independently fetch PR data for the same workspaces.
 *
 * This is a pure optimization layer — correctness is unaffected if the registry is wrong
 * or cleared (e.g. on server restart).
 */

const DEFAULT_COOLDOWN_MS = 90_000; // 90 seconds

class PRFetchRegistry {
  private readonly lastFetchedAt = new Map<string, number>();

  /**
   * Record that a GitHub PR fetch was performed for a workspace.
   * Call this after a successful fetch.
   */
  register(workspaceId: string): void {
    this.lastFetchedAt.set(workspaceId, Date.now());
  }

  /**
   * Returns true if this workspace was fetched within the cooldown window.
   * Use this to skip redundant fetches.
   */
  isRecentlyFetched(workspaceId: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
    const lastFetch = this.lastFetchedAt.get(workspaceId);
    if (lastFetch === undefined) {
      return false;
    }
    return Date.now() - lastFetch < cooldownMs;
  }

  /**
   * Clear all entries. Useful in tests.
   */
  clear(): void {
    this.lastFetchedAt.clear();
  }
}

export const prFetchRegistry = new PRFetchRegistry();
