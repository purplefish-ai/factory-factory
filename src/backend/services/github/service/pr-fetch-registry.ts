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

interface InFlightFetchClaim {
  startedAt: number;
  claimToken: number;
}

export class PRFetchRegistry {
  // Completed timestamps cannot be age-pruned because callers may supply any cooldown.
  // Explicit cleanup and oldest-workspace capacity eviction bound their retention.
  private readonly lastFetchedAt = new Map<string, number>();
  private readonly inFlightClaims = new Map<string, InFlightFetchClaim>();
  private nextClaimToken = 0;

  private pruneExpiredInFlight(now: number): void {
    for (const [workspaceId, claim] of this.inFlightClaims) {
      if (now - claim.startedAt >= SERVICE_CACHE_TTL_MS.workspacePrFetchInFlight) {
        this.inFlightClaims.delete(workspaceId);
      }
    }
  }

  private ensureCapacityFor(workspaceId: string): void {
    if (this.lastFetchedAt.has(workspaceId) || this.inFlightClaims.has(workspaceId)) {
      return;
    }

    const workspaceIds = new Set([...this.lastFetchedAt.keys(), ...this.inFlightClaims.keys()]);
    if (workspaceIds.size < SERVICE_LIMITS.workspaceScopedCacheMaxEntries) {
      return;
    }

    let oldestWorkspaceId: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [candidateWorkspaceId, timestamp] of this.lastFetchedAt) {
      if (timestamp < oldestTimestamp) {
        oldestWorkspaceId = candidateWorkspaceId;
        oldestTimestamp = timestamp;
      }
    }
    for (const [candidateWorkspaceId, claim] of this.inFlightClaims) {
      if (claim.startedAt < oldestTimestamp) {
        oldestWorkspaceId = candidateWorkspaceId;
        oldestTimestamp = claim.startedAt;
      }
    }

    if (oldestWorkspaceId !== undefined) {
      this.lastFetchedAt.delete(oldestWorkspaceId);
      this.inFlightClaims.delete(oldestWorkspaceId);
    }
  }

  /**
   * Claim this workspace synchronously before starting an async fetch.
   * Subsequent `isRecentlyFetched` calls will return true until the claim is
   * registered, canceled, expired, evicted at capacity, or removed by cleanup.
   */
  startFetch(workspaceId: string): number {
    const now = Date.now();
    this.pruneExpiredInFlight(now);
    this.ensureCapacityFor(workspaceId);
    this.nextClaimToken += 1;
    const claimToken = this.nextClaimToken;
    this.inFlightClaims.set(workspaceId, { startedAt: now, claimToken });
    return claimToken;
  }

  /**
   * Record that a GitHub PR fetch was performed for a workspace.
   * Clears only the matching in-flight claim set by `startFetch`.
   * Call this after a successful fetch.
   */
  register(workspaceId: string, claimToken: number): void {
    const now = Date.now();
    this.pruneExpiredInFlight(now);
    if (this.inFlightClaims.get(workspaceId)?.claimToken !== claimToken) {
      return;
    }
    this.inFlightClaims.delete(workspaceId);
    this.lastFetchedAt.set(workspaceId, now);
  }

  /**
   * Release the matching in-flight claim without recording a successful fetch timestamp.
   * Call this when a fetch fails so the workspace becomes eligible again.
   */
  cancelFetch(workspaceId: string, claimToken: number): void {
    this.pruneExpiredInFlight(Date.now());
    if (this.inFlightClaims.get(workspaceId)?.claimToken === claimToken) {
      this.inFlightClaims.delete(workspaceId);
    }
  }

  /**
   * Returns true if this workspace has an in-flight fetch or was fetched within
   * the cooldown window. Use this to skip redundant fetches.
   */
  isRecentlyFetched(workspaceId: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
    const now = Date.now();
    this.pruneExpiredInFlight(now);
    if (this.inFlightClaims.has(workspaceId)) {
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
    this.pruneExpiredInFlight(Date.now());
    return this.inFlightClaims.has(workspaceId);
  }

  /**
   * Remove all state retained for one workspace.
   */
  removeWorkspace(workspaceId: string): void {
    this.pruneExpiredInFlight(Date.now());
    this.lastFetchedAt.delete(workspaceId);
    this.inFlightClaims.delete(workspaceId);
  }

  /**
   * Return retained entry counts after discarding expired in-flight claims.
   */
  size(): { completed: number; inFlight: number } {
    this.pruneExpiredInFlight(Date.now());
    return {
      completed: this.lastFetchedAt.size,
      inFlight: this.inFlightClaims.size,
    };
  }

  /**
   * Clear all entries without resetting claim identity. Useful in tests.
   */
  clear(): void {
    this.lastFetchedAt.clear();
    this.inFlightClaims.clear();
  }
}

export const prFetchRegistry = new PRFetchRegistry();
