# Workspace Cache Retention Design

## Problem

Workspace archive currently removes the visible snapshot and activity state through the event collector, but it leaves three process-lifetime collections behind: snapshot removal tombstones, completed PR-fetch timestamps, and idle PR-refresh timestamps. Deletion follows a separate cleanup path. A pending coalesced update can also flush after archive with a new wall-clock timestamp and bypass the snapshot tombstone.

## Approaches Considered

1. **Bounded tombstones plus one archive cleanup hook (chosen).** Keep timestamp ordering for reconciliation safety, expire tombstones after a ten-minute grace period, and explicitly evict every workspace-scoped optimization cache through one idempotent hook. This is narrowly scoped and preserves the existing reconciliation contract.
2. **Generations across all workspace updates.** Give every workspace lifecycle and asynchronous operation an incarnation token. This is the strongest reuse model, but it would change event, reconciliation, GitHub-fetch, and session-summary APIs for a cache-retention fix.
3. **Periodic global sweepers only.** Run background jobs over all maps. This bounds retention eventually, but adds timers and lifecycle management while leaving archive cleanup delayed and the coalescer resurrection race unresolved.

## Design

`EventCollectorOrchestrator` will own the central `removeWorkspace(workspaceId)` operation because it owns the collector-local idle throttle and coalescer. The operation will cancel a pending coalesced update, delete the idle-refresh timestamp, remove the snapshot, clear workspace activity, and call `prFetchRegistry.removeWorkspace`. The default collector exposes this as `cleanupWorkspaceScopedCaches(workspaceId)`.

The ARCHIVED state listener will call that hook immediately. `completeArchive()` will call it again after `markArchived()` so archive cleanup remains reliable when the collector is not configured; the double call is intentionally idempotent. The delete mutation will call the same hook after the database deletion succeeds. Runtime and worktree cleanup remain in their existing orchestration paths.

`WorkspaceSnapshotStore` will store tombstone metadata containing the logical removal timestamp and a wall-clock expiration. A per-tombstone unref'd timer removes it after `SERVICE_CACHE_TTL_MS.workspaceSnapshotRemovalGrace` (ten minutes). A newer upsert clears the tombstone and its timer immediately. Repeated removal keeps the greatest logical removal timestamp and refreshes the grace period, so an older duplicate cannot weaken protection. `clear()` cancels every timer.

`PRFetchRegistry` will expose `removeWorkspace`, prune abandoned in-flight claims after ten minutes, and cap optimization-only tracking at 1,024 workspaces. Completed timestamps are not age-pruned because `isRecentlyFetched` supports arbitrary caller cooldowns; they are bounded by explicit workspace cleanup and oldest-timestamp eviction at capacity. Successful completion will only be recorded when the matching in-flight claim still exists, so a fetch that completes after archive cleanup cannot consume a newer claim or recreate a completed-fetch entry. Idle-refresh timestamps use their existing 30-second cooldown as a TTL and the same 1,024-entry defensive cap.

## Safety and Reuse

- Reconciliation uses its poll-start timestamp. An archive tombstone therefore rejects a pass that began before archive throughout the grace window.
- A valid update with a timestamp newer than removal is accepted immediately and clears the tombstone, supporting deliberate ID recreation.
- After grace expiry, the tombstone is physically removed even if no later operation touches the store.
- Missing and repeated cleanup calls are no-ops except for refreshing the bounded protection window.
- Canceling the coalescer before removing the snapshot prevents queued pre-archive events from flushing afterward.
- PR and idle registries are correctness-neutral optimizations; TTL/cap eviction may cause an extra refresh but cannot corrupt persisted state.

## Testing

Focused tests will cover archive during reconciliation, repeated and missing removals, timer expiry, newer updates, clearing timers, PR completed/in-flight eviction, stale completion after cleanup, TTL/cap bounds, idle-throttle eviction, pending coalescer cancellation, explicit archive cleanup, and deletion cleanup. Full typecheck, formatting, test, and build commands will run before publication.
