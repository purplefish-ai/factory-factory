# Non-Blocking PR Status Sync on App Load

## Problem Statement

When a user opens the app and selects a project, the frontend fires `workspace.syncAllPRStatuses` — a tRPC mutation that calls `gh pr view` for every workspace with an open PR. The server holds the HTTP connection open until **all** GitHub CLI calls finish. When GitHub's API is rate-limited or slow, this blocks the open HTTP connection for up to 90 seconds (worst case), degrading the perceived app load time and keeping the browser waiting on a request that the UI cannot usefully act on anyway.

---

## Root Cause Analysis

### 1. Server-side: fully blocking `await`

`workspace-query.service.ts:414` awaits the entire `Promise.all` before returning:

```ts
await Promise.all(
  workspacesWithPRs.map((workspace) =>
    gitConcurrencyLimit(async () => {
      const prResult = await this.prSnapshot.refreshWorkspace(workspace.id, workspace.prUrl);
      ...
    })
  )
);
return { synced, failed };  // returned only after all gh calls complete
```

With `gitConcurrencyLimit = pLimit(3)` and a 30s per-call timeout (`GH_TIMEOUT_MS.default`), worst-case duration is `⌈N/3⌉ × 30s`. At 5 workspaces with PRs: **2 waves × 30s = 60s**.

### 2. Client-side: no HTTP timeout

The tRPC client (`src/client/lib/trpc.ts`) uses `httpBatchLink` with no fetch timeout. The browser holds the connection open indefinitely.

### 3. WebSocket already does the update — the `onSuccess` invalidation is redundant

When `prSnapshot.refreshWorkspace()` saves each result to the DB, it calls `this.emit(PR_SNAPSHOT_UPDATED, ...)` (`pr-snapshot.service.ts:250`). The event-collector orchestrator (`event-collector.orchestrator.ts:463`) is already listening and pushes `snapshot_changed` events over WebSocket. The client's `useProjectSnapshotSync` receives these and updates React Query caches live — sidebar badges and Kanban cards update one by one as each `gh` call completes.

The `onSuccess` callback in `use-app-navigation-data.ts:31-33` that invalidates `getProjectSummaryState` is therefore redundant: by the time the HTTP response arrives, all WebSocket updates have already landed.

### 4. Kanban manual refresh blocks before refetching

`kanban-context.tsx:165-169` awaits the mutation before calling `refetchWorkspaces()` and `refetchIssues()`:

```ts
const syncAndRefetch = async () => {
  await syncMutation.mutateAsync({ projectId }); // waits up to 60s
  refetchWorkspaces();
  refetchIssues();
};
```

This means users clicking the Kanban refresh button see a spinner for the entire duration of all `gh` calls.

---

## Proposed Fix

Three targeted changes; no new infrastructure needed.

### Change 1 — Server: fire-and-forget the GitHub calls

**`src/backend/services/workspace/service/query/workspace-query.service.ts`**

Remove the `await` from `Promise.all`. Return immediately after queuing the work. Attach a `.catch()` to prevent unhandled rejections.

```ts
async syncAllPRStatuses(projectId: string) {
  const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, {
    excludeStatuses: [WorkspaceStatus.ARCHIVING, WorkspaceStatus.ARCHIVED],
  });

  const workspacesWithPRs = workspaces.filter(
    (w): w is typeof w & { prUrl: string } => w.prUrl !== null
  );

  if (workspacesWithPRs.length === 0) {
    return { queued: 0 };
  }

  // Fire-and-forget: results are pushed to clients via WebSocket as each call completes.
  Promise.all(
    workspacesWithPRs.map((workspace) =>
      gitConcurrencyLimit(() =>
        this.prSnapshot.refreshWorkspace(workspace.id, workspace.prUrl)
      )
    )
  )
    .then(() => logger.info('Batch PR status sync completed', { projectId }))
    .catch((err) => logger.error('Batch PR status sync failed', toError(err), { projectId }));

  return { queued: workspacesWithPRs.length };
}
```

The DB query is still awaited (fast, < 5ms). HTTP response time drops from up to 60s → ~5ms.

### Change 2 — Client on-load: drop the redundant `onSuccess` invalidation

**`src/client/hooks/use-app-navigation-data.ts`**

```ts
// Before
const syncAllPRStatuses = trpc.workspace.syncAllPRStatuses.useMutation({
  onSuccess: () => {
    utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
  },
});

// After
const syncAllPRStatuses = trpc.workspace.syncAllPRStatuses.useMutation();
```

The `.mutate()` call in the `useEffect` stays unchanged — it still kicks off the background sync. Badge updates arrive via WebSocket as before.

### Change 3 — Kanban manual refresh: fire-and-forget, refetch immediately

**`src/client/components/kanban/kanban-context.tsx`**

```ts
// Before
const syncAndRefetch = async () => {
  await syncMutation.mutateAsync({ projectId });
  refetchWorkspaces();
  refetchIssues();
};

// After
const syncAndRefetch = () => {
  syncMutation.mutate({ projectId }); // fire-and-forget; WS pushes PR badge updates
  refetchWorkspaces();
  refetchIssues();
};
```

`refetchWorkspaces()` and `refetchIssues()` run immediately rather than waiting for all `gh` calls. Workspace PR badges update via WebSocket as each result arrives.

---

## Data Flow After the Fix

```
User opens project
       │
       ▼
syncAllPRStatuses.mutate()  ──HTTP──►  server awaits DB query (~5ms)
                                       └─ returns { queued: N } immediately
       │
       │  (HTTP response arrives ~5ms)
       │
       │              server (background)
       │              for each workspace w/ PR:
       │                gh pr view ...   ──► GitHub API
       │                     │
       │                     ▼
       │              prSnapshot.applySnapshot()
       │                     │
       │                     ▼
       │              emit PR_SNAPSHOT_UPDATED
       │                     │
       │                     ▼
       │              event-collector updates snapshotStore
       │                     │
       │                     ▼
       └──── WebSocket ◄── snapshot_changed broadcast
                    │
                    ▼
          useProjectSnapshotSync updates React Query caches
                    │
                    ▼
          Sidebar badges + Kanban cards re-render ✓
```

---

## What Does Not Change

- The ratchet poller continues to refresh PR statuses every ~60s regardless.
- The `gitConcurrencyLimit(3)` and per-call 30s timeout are unchanged — the background work behaves identically, it just no longer blocks the HTTP response.
- The WebSocket snapshot mechanism is unchanged; this fix relies entirely on existing infrastructure.
- No changes to the tRPC schema; the return type shape changes from `{ synced, failed }` to `{ queued }` but callers don't consume the return value.
