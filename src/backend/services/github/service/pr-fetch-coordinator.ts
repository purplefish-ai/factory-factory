/**
 * PR Fetch Coordinator
 *
 * One entry point for the background PR fetches that the scheduler's PR sync
 * and the ratchet both perform against the same workspaces. A caller hands it
 * the fetch; it decides whether the fetch runs at all, and owns the bookkeeping
 * that makes that decision.
 *
 * This is a pure optimization layer — correctness is unaffected if its state is
 * wrong or cleared (e.g. on server restart).
 *
 * What it is *not*: a rate limiter. The shared GitHub budget already lives one
 * level down, in `GitHubCLIService` — a process-wide concurrency limit on `gh`
 * spawns, a rate-limit fast-fail that short-circuits every call for a minute
 * once GitHub pushes back, and singleflight dedup of identical in-flight read
 * commands. That last one cannot help here, because the scheduler and the
 * ratchet fetch the same workspace with *different* `gh` commands; deduping
 * them needs a workspace-level view, which is this file.
 *
 * Why a callback rather than the claim/release pair it replaces: the claim was
 * three calls (`startFetch`, then `register` or `cancelFetch`) plus a token the
 * caller had to thread through its own try/catch, duplicated at both call sites
 * and exposed as five methods on the ratchet's GitHub bridge. Scoping the claim
 * to a callback makes releasing it a `finally` rather than a caller obligation,
 * and reduces the bridge to one method. The token survives as an internal
 * detail because claims can still expire (see `pruneExpiredInFlight`), so a
 * late release must not delete a newer claim.
 *
 * Atomicity: the skip check and the claim both happen in `coordinate`'s
 * synchronous prefix, before the fetch is awaited, so concurrent callers cannot
 * race past the check and issue duplicate GitHub calls.
 */

import { SERVICE_CACHE_TTL_MS, SERVICE_LIMITS } from '@/backend/services/constants';

const DEFAULT_COOLDOWN_MS = 90_000; // 90 seconds

interface InFlightFetchClaim {
  startedAt: number;
  claimToken: number;
}

/**
 * Either the fetch ran and this is what it returned, or the coordinator
 * declined to run it because someone else already has.
 */
export type CoordinatedFetch<T> =
  | { status: 'fetched'; value: T }
  | { status: 'skipped'; reason: 'recently_fetched' };

export interface CoordinateOptions<T> {
  /** How recent a completed fetch has to be to suppress this one. */
  cooldownMs?: number;
  /**
   * Ignore the completed-fetch cooldown, but still defer to a fetch that is
   * actively in flight. For event-driven checks that fire right after another
   * service's fetch completed — recomputing now is the entire point of them —
   * while never issuing a duplicate concurrent GitHub call.
   */
  ignoreCooldown?: boolean;
  /**
   * Whether a returned value counts as a successful fetch and should start the
   * cooldown. Defaults to true. Callers that report failure as a value rather
   * than an exception need this: without it a failed refresh would suppress
   * retries for the whole cooldown window.
   */
  countsAsFetched?: (value: T) => boolean;
}

export class PRFetchCoordinator {
  // Completed timestamps cannot be age-pruned because callers may supply any cooldown.
  // Explicit cleanup and oldest-workspace capacity eviction bound their retention.
  private readonly lastFetchedAt = new Map<string, number>();
  private readonly inFlightClaims = new Map<string, InFlightFetchClaim>();
  private nextClaimToken = 0;

  /**
   * Run `fetch` unless this workspace was fetched recently or is being fetched
   * right now, in which case skip it and say so.
   */
  async coordinate<T>(
    workspaceId: string,
    fetch: () => Promise<T>,
    options?: CoordinateOptions<T>
  ): Promise<CoordinatedFetch<T>> {
    const now = Date.now();
    this.pruneExpiredInFlight(now);

    if (this.inFlightClaims.has(workspaceId)) {
      return { status: 'skipped', reason: 'recently_fetched' };
    }
    if (!options?.ignoreCooldown && this.isWithinCooldown(workspaceId, now, options?.cooldownMs)) {
      return { status: 'skipped', reason: 'recently_fetched' };
    }

    const claimToken = this.claim(workspaceId, now);
    try {
      const value = await fetch();
      if (options?.countsAsFetched?.(value) ?? true) {
        this.recordCompleted(workspaceId, claimToken);
      } else {
        this.release(workspaceId, claimToken);
      }
      return { status: 'fetched', value };
    } catch (error) {
      // Release rather than record: a failed fetch must leave the workspace
      // eligible for a retry instead of sitting out the cooldown.
      this.release(workspaceId, claimToken);
      throw error;
    }
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

  private isWithinCooldown(workspaceId: string, now: number, cooldownMs?: number): boolean {
    const lastFetch = this.lastFetchedAt.get(workspaceId);
    if (lastFetch === undefined) {
      return false;
    }
    return now - lastFetch < (cooldownMs ?? DEFAULT_COOLDOWN_MS);
  }

  private claim(workspaceId: string, now: number): number {
    this.ensureCapacityFor(workspaceId);
    this.nextClaimToken += 1;
    const claimToken = this.nextClaimToken;
    this.inFlightClaims.set(workspaceId, { startedAt: now, claimToken });
    return claimToken;
  }

  /**
   * Retire a claim, one way or the other. Identity-checked because a claim that
   * outlived `workspacePrFetchInFlight` has already been pruned and possibly
   * replaced — without the check, a slow fetch settling late would delete a
   * newer fetch's claim and let a third caller run concurrently with it.
   */
  private release(workspaceId: string, claimToken: number): void {
    if (this.inFlightClaims.get(workspaceId)?.claimToken === claimToken) {
      this.inFlightClaims.delete(workspaceId);
    }
  }

  private recordCompleted(workspaceId: string, claimToken: number): void {
    if (this.inFlightClaims.get(workspaceId)?.claimToken !== claimToken) {
      return;
    }
    this.inFlightClaims.delete(workspaceId);
    this.lastFetchedAt.set(workspaceId, Date.now());
  }

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
}

export const prFetchCoordinator = new PRFetchCoordinator();
