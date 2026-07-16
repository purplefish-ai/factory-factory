/**
 * PR Fetch Registry
 *
 * In-memory registry tracking when a GitHub PR fetch was last performed per workspace.
 * Used to deduplicate concurrent background polling between the scheduler and ratchet,
 * which both independently fetch PR data for the same workspaces.
 *
 * This is a pure optimization layer — correctness is unaffected if the registry is wrong
 * or cleared (e.g. on server restart).
 *
 * Atomicity: `startFetch` claims a workspace synchronously before any async work begins.
 * `isRecentlyFetched` treats in-flight fetches as recent, preventing concurrent callers
 * from racing past the check and issuing duplicate GitHub API calls.
 */

const DEFAULT_COOLDOWN_MS = 90_000; // 90 seconds

class PRFetchRegistry {
  private readonly lastFetchedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  /**
   * Claim this workspace synchronously before starting an async fetch.
   * Subsequent `isRecentlyFetched` calls will return true until `register` or
   * `cancelFetch` is called.
   */
  startFetch(workspaceId: string): void {
    this.inFlight.add(workspaceId);
  }

  /**
   * Record that a GitHub PR fetch was performed for a workspace.
   * Clears any in-flight claim set by `startFetch`.
   * Call this after a successful fetch.
   */
  register(workspaceId: string): void {
    this.inFlight.delete(workspaceId);
    this.lastFetchedAt.set(workspaceId, Date.now());
  }

  /**
   * Release an in-flight claim without recording a successful fetch timestamp.
   * Call this when a fetch fails so the workspace becomes eligible again.
   */
  cancelFetch(workspaceId: string): void {
    this.inFlight.delete(workspaceId);
  }

  /**
   * Returns true if this workspace has an in-flight fetch or was fetched within
   * the cooldown window. Use this to skip redundant fetches.
   */
  isRecentlyFetched(workspaceId: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
    if (this.inFlight.has(workspaceId)) {
      return true;
    }
    const lastFetch = this.lastFetchedAt.get(workspaceId);
    if (lastFetch === undefined) {
      return false;
    }
    return Date.now() - lastFetch < cooldownMs;
  }

  /**
   * Returns true only while a fetch is actively in flight for this workspace.
   * Callers that bypass the completed-fetch cooldown must still honor this to
   * avoid issuing a duplicate concurrent GitHub call.
   */
  isFetchInFlight(workspaceId: string): boolean {
    return this.inFlight.has(workspaceId);
  }

  /**
   * Clear all entries. Useful in tests.
   */
  clear(): void {
    this.lastFetchedAt.clear();
    this.inFlight.clear();
  }
}

export const prFetchRegistry = new PRFetchRegistry();
