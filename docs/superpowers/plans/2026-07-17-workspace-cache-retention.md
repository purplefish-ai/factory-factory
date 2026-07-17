# Workspace Cache Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound workspace-scoped in-memory retention and make archive/delete cleanup explicit, idempotent, and reconciliation-safe.

**Architecture:** The event collector owns one workspace cleanup hook because it contains the only collector-local cache. Snapshot tombstones retain logical ordering for ten minutes with physical timer-based expiry; PR and idle refresh registries use explicit removal plus TTL/cap pruning because they are optimization-only.

**Tech Stack:** TypeScript, Node.js timers/EventEmitter, Vitest, Express/tRPC orchestration.

## Global Constraints

- Snapshot removal grace is exactly `10 * 60_000` milliseconds.
- Abandoned PR in-flight claims expire after exactly `10 * 60_000` milliseconds.
- Optimization-only workspace registries track at most `1_024` workspaces.
- Cleanup is idempotent and safe for missing workspace entries.
- A reconciliation begun before archive cannot recreate a snapshot during the grace window.
- A valid update newer than removal is accepted immediately.
- Existing service-capsule barrel import boundaries remain intact.

---

### Task 1: Bound Snapshot Removal Tombstones

**Files:**
- Modify: `src/backend/services/constants.ts`
- Modify: `src/backend/services/workspace-snapshot-store.service.ts`
- Test: `src/backend/services/workspace-snapshot-store.service.test.ts`

**Interfaces:**
- Consumes: `SERVICE_CACHE_TTL_MS.workspaceSnapshotRemovalGrace`.
- Produces: `WorkspaceSnapshotStore.removalTombstoneCount(): number` and timer-backed bounded retention behind the existing `remove`/`upsert` API.

- [ ] **Step 1: Write failing tombstone retention tests**

```ts
it('expires removal protection after the configured grace period', () => {
  vi.setSystemTime(1_000);
  store.remove('ws-1', 900);
  vi.advanceTimersByTime(10 * 60_000);
  expect(store.removalTombstoneCount()).toBe(0);
});

it('repeated removal preserves the newest logical timestamp', () => {
  store.remove('ws-1', 200);
  store.remove('ws-1', 150);
  store.upsert('ws-1', makeUpdate(), 'reconciliation', 175);
  expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm exec vitest run src/backend/services/workspace-snapshot-store.service.test.ts`

Expected: failure because `removalTombstoneCount` and expiry do not exist.

- [ ] **Step 3: Implement timer-backed tombstones**

```ts
type RemovalTombstone = { removedAt: number; expiresAt: number; timer: NodeJS.Timeout };

private clearRemovalTombstone(workspaceId: string): void {
  const tombstone = this.removalTimestamps.get(workspaceId);
  if (tombstone) clearTimeout(tombstone.timer);
  this.removalTimestamps.delete(workspaceId);
}
```

On removal, retain the maximum `removedAt`, schedule an unref'd expiry timer for the configured grace, and replace the prior timer. On newer upsert or `clear()`, cancel the timer before deleting metadata.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `pnpm exec vitest run src/backend/services/workspace-snapshot-store.service.test.ts`

Expected: all snapshot-store tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/constants.ts src/backend/services/workspace-snapshot-store.service.ts src/backend/services/workspace-snapshot-store.service.test.ts
git commit -m "Bound snapshot removal tombstones (#1949)"
```

### Task 2: Bound the PR Fetch Registry

**Files:**
- Modify: `src/backend/services/github/service/pr-fetch-registry.ts`
- Create: `src/backend/services/github/service/pr-fetch-registry.test.ts`

**Interfaces:**
- Consumes: `SERVICE_LIMITS.workspaceScopedCacheMaxEntries` and `SERVICE_CACHE_TTL_MS.workspacePrFetchInFlight`.
- Produces: exported `PRFetchRegistry`, `removeWorkspace(workspaceId): void`, and `size(): { completed: number; inFlight: number }`.

- [ ] **Step 1: Write failing registry tests**

```ts
it('removes completed and in-flight entries for one workspace', () => {
  registry.startFetch('ws-1');
  registry.register('ws-1');
  registry.startFetch('ws-2');
  registry.removeWorkspace('ws-1');
  registry.removeWorkspace('ws-2');
  expect(registry.size()).toEqual({ completed: 0, inFlight: 0 });
});

it('does not record a completion after workspace cleanup', () => {
  registry.startFetch('ws-1');
  registry.removeWorkspace('ws-1');
  registry.register('ws-1');
  expect(registry.size()).toEqual({ completed: 0, inFlight: 0 });
});
```

Also cover missing/repeated removal, cooldown expiry, abandoned in-flight expiry, capacity eviction, and reuse after cleanup.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm exec vitest run src/backend/services/github/service/pr-fetch-registry.test.ts`

Expected: import/API failures because the class and per-workspace methods are unavailable.

- [ ] **Step 3: Implement TTL/cap pruning and removal**

Use timestamp maps for completed and in-flight entries. Prune expired entries before reads/writes, evict the oldest entry when inserting a new workspace at the 1,024-entry cap, and only register a successful completion if an in-flight claim was removed.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `pnpm exec vitest run src/backend/services/github/service/pr-fetch-registry.test.ts`

Expected: all PR registry tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/github/service/pr-fetch-registry.ts src/backend/services/github/service/pr-fetch-registry.test.ts
git commit -m "Bound PR fetch registry retention (#1949)"
```

### Task 3: Centralize Workspace Cache Cleanup

**Files:**
- Modify: `src/backend/orchestration/event-collector.orchestrator.ts`
- Modify: `src/backend/orchestration/event-collector.orchestrator.test.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.test.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`
- Modify: `src/backend/trpc/workspace.router.test.ts`

**Interfaces:**
- Consumes: `prFetchRegistry.removeWorkspace`, `workspaceSnapshotStore.remove`, and `workspaceActivityService.clearWorkspace`.
- Produces: `EventCoalescer.removeWorkspace(workspaceId): void`, `EventCollectorOrchestrator.removeWorkspace(workspaceId): void`, and `cleanupWorkspaceScopedCaches(workspaceId): void`.

- [ ] **Step 1: Write failing cleanup integration tests**

```ts
it('cancels a pending update for an archived workspace', () => {
  coalescer.enqueue('ws-1', makeFields(), 'test');
  coalescer.removeWorkspace('ws-1');
  vi.advanceTimersByTime(150);
  expect(mockStore.upsert).not.toHaveBeenCalled();
});
```

Extend archive-event tests to assert PR-fetch and idle-throttle eviction. Extend archive completion and delete tests to assert the exported hook runs after successful persistence and remains safe when also invoked by the state event.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm exec vitest run src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/trpc/workspace.router.test.ts`

Expected: failures because the central cleanup APIs and calls do not exist.

- [ ] **Step 3: Implement the central hook and defensive idle pruning**

Move idle-refresh timestamps into `EventCollectorState`. Before each idle refresh, delete entries at least 30 seconds old and enforce the 1,024-entry cap. `removeWorkspace` cancels coalescer state, removes the idle timestamp, and clears snapshot, activity, and PR registry state. Call the default wrapper from the ARCHIVED listener, after `markArchived()`, and after successful database deletion.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `pnpm exec vitest run src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/trpc/workspace.router.test.ts`

Expected: all focused cleanup tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/orchestration/event-collector.orchestrator.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/workspace-archive.orchestrator.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/trpc/workspace.trpc.ts src/backend/trpc/workspace.router.test.ts
git commit -m "Centralize workspace cache cleanup (#1949)"
```

### Task 4: Verify, Review, and Publish

**Files:**
- Modify only files required by formatter or review findings.

**Interfaces:**
- Consumes: all prior task behavior and issue #1949 acceptance criteria.
- Produces: a clean branch and GitHub pull request closing #1949.

- [ ] **Step 1: Run focused regression tests**

Run: `pnpm exec vitest run src/backend/services/workspace-snapshot-store.service.test.ts src/backend/services/github/service/pr-fetch-registry.test.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/trpc/workspace.router.test.ts`

Expected: all focused tests pass.

- [ ] **Step 2: Run repository verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: every command exits zero; inspect formatter changes before staging.

- [ ] **Step 3: Review the full branch diff**

Run: `git diff origin/main` and `git status --short --branch`.

Expected: only issue-scoped code/tests/docs are present, with no debug output or unrelated edits.

- [ ] **Step 4: Request a whole-branch code review and fix blocking findings**

Review from `git merge-base origin/main HEAD` through `HEAD` against the design and acceptance criteria. Re-run covering tests for every fix.

- [ ] **Step 5: Push and create the pull request**

```bash
git push -u origin HEAD
gh pr create --title "Fix #1949: Prune archived workspace caches" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: GitHub returns the created pull request URL.
