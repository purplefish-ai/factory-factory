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

import { SERVICE_CACHE_TTL_MS, SERVICE_LIMITS } from '@/backend/services/constants';

const DEFAULT_COOLDOWN_MS = 90_000; // 90 seconds

export class PRFetchRegistry {
  private readonly lastFetchedAt = new Map<string, number>();
  private readonly inFlightStartedAt = new Map<string, number>();

  private pruneExpired(
    now: number,
    completedEntryToPreserve?: { workspaceId: string; cooldownMs: number }
  ): void {
    for (const [workspaceId, lastFetchedAt] of this.lastFetchedAt) {
      if (
        workspaceId === completedEntryToPreserve?.workspaceId &&
        now - lastFetchedAt < completedEntryToPreserve.cooldownMs
      ) {
        continue;
      }
      if (now - lastFetchedAt >= DEFAULT_COOLDOWN_MS) {
        this.lastFetchedAt.delete(workspaceId);
      }
    }

    for (const [workspaceId, startedAt] of this.inFlightStartedAt) {
      if (now - startedAt >= SERVICE_CACHE_TTL_MS.workspacePrFetchInFlight) {
        this.inFlightStartedAt.delete(workspaceId);
      }
    }
  }

  private ensureCapacityFor(workspaceId: string): void {
    if (this.lastFetchedAt.has(workspaceId) || this.inFlightStartedAt.has(workspaceId)) {
      return;
    }

    const workspaceIds = new Set([...this.lastFetchedAt.keys(), ...this.inFlightStartedAt.keys()]);
    if (workspaceIds.size < SERVICE_LIMITS.workspaceScopedCacheMaxEntries) {
      return;
    }

    let oldestWorkspaceId: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [candidateWorkspaceId, timestamp] of [
      ...this.lastFetchedAt,
      ...this.inFlightStartedAt,
    ]) {
      if (timestamp < oldestTimestamp) {
        oldestWorkspaceId = candidateWorkspaceId;
        oldestTimestamp = timestamp;
      }
    }

    if (oldestWorkspaceId !== undefined) {
      this.lastFetchedAt.delete(oldestWorkspaceId);
      this.inFlightStartedAt.delete(oldestWorkspaceId);
    }
  }

  /**
   * Claim this workspace synchronously before starting an async fetch.
   * Subsequent `isRecentlyFetched` calls will return true until the claim is
   * registered, canceled, expired, evicted at capacity, or removed by cleanup.
   */
  startFetch(workspaceId: string): void {
    const now = Date.now();
    this.pruneExpired(now);
    this.ensureCapacityFor(workspaceId);
    this.inFlightStartedAt.set(workspaceId, now);
  }

  /**
   * Record that a GitHub PR fetch was performed for a workspace.
   * Clears any in-flight claim set by `startFetch`.
   * Call this after a successful fetch.
   */
  register(workspaceId: string): void {
    const now = Date.now();
    this.pruneExpired(now);
    if (this.inFlightStartedAt.delete(workspaceId)) {
      this.lastFetchedAt.set(workspaceId, now);
    }
  }

  /**
   * Release an in-flight claim without recording a successful fetch timestamp.
   * Call this when a fetch fails so the workspace becomes eligible again.
   */
  cancelFetch(workspaceId: string): void {
    this.pruneExpired(Date.now());
    this.inFlightStartedAt.delete(workspaceId);
  }

  /**
   * Returns true if this workspace has an in-flight fetch or was fetched within
   * the cooldown window. Use this to skip redundant fetches.
   */
  isRecentlyFetched(workspaceId: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
    const now = Date.now();
    this.pruneExpired(now, { workspaceId, cooldownMs });
    if (this.inFlightStartedAt.has(workspaceId)) {
      return true;
    }
    const lastFetch = this.lastFetchedAt.get(workspaceId);
    if (lastFetch === undefined) {
      return false;
    }
    return now - lastFetch < cooldownMs;
  }

  /**
   * Returns true only while a fetch is actively in flight for this workspace.
   * Callers that bypass the completed-fetch cooldown must still honor this to
   * avoid issuing a duplicate concurrent GitHub call.
   */
  isFetchInFlight(workspaceId: string): boolean {
    this.pruneExpired(Date.now());
    return this.inFlightStartedAt.has(workspaceId);
  }

  /**
   * Remove all state retained for one workspace.
   */
  removeWorkspace(workspaceId: string): void {
    this.pruneExpired(Date.now());
    this.lastFetchedAt.delete(workspaceId);
    this.inFlightStartedAt.delete(workspaceId);
  }

  /**
   * Return retained entry counts after discarding expired state.
   */
  size(): { completed: number; inFlight: number } {
    this.pruneExpired(Date.now());
    return {
      completed: this.lastFetchedAt.size,
      inFlight: this.inFlightStartedAt.size,
    };
  }

  /**
   * Clear all entries. Useful in tests.
   */
  clear(): void {
    this.lastFetchedAt.clear();
    this.inFlightStartedAt.clear();
  }
}

export const prFetchRegistry = new PRFetchRegistry();
