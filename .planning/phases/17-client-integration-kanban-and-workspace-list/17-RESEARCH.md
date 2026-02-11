# Phase 17: Client Integration - Kanban and Workspace List - Research

**Researched:** 2026-02-11
**Domain:** Extending WebSocket-driven snapshot sync to Kanban board and workspace list views
**Confidence:** HIGH

## Summary

Phase 17 extends the WebSocket-to-cache sync pattern established in Phase 16 (sidebar) to two additional consumers: the Kanban board and the workspace list (table view). The sidebar already uses `useProjectSnapshotSync` to push `/snapshots` WebSocket data into the `getProjectSummaryState` React Query cache, reducing update latency from 2s polling to ~200ms. The Kanban board currently polls `listWithKanbanState` at 15s intervals and the workspace list (table view) polls `workspace.list` at 15s intervals. Both need to be migrated to use snapshot-driven real-time updates.

The central challenge is a **data shape mismatch**: the Kanban board consumes `WorkspaceWithKanban` (which extends the full Prisma `Workspace` model with ~30 fields), while the snapshot entry has ~25 fields covering a different surface. Specifically, the Kanban card uses `description`, `initErrorMessage`, and `status` (for the WorkspaceStatusBadge), and the KanbanProvider uses `githubIssueNumber` to filter issues. Of these, `status` IS present in the snapshot entry, but `description`, `initErrorMessage`, and `githubIssueNumber` are NOT. However, `listWithKanbanState` already filters to non-archived workspaces (hardcodes `isArchived: false`), so the snapshot has enough data for the critical real-time fields (kanban column, working status, PR state, ratchet state). The practical approach is to update the `listWithKanbanState` React Query cache via `setData` from WebSocket messages, mapping snapshot entries to the `WorkspaceWithKanban` shape. For fields missing from the snapshot (`description`, `initErrorMessage`, `githubIssueNumber`), the approach is to **merge with existing cache data** on `snapshot_changed` messages (preserving these fields from the prior cache entry) and to rely on the safety-net poll to backfill them for new workspaces.

For the workspace list (table view), the situation is simpler. The table view uses `workspace.list` which returns the full Prisma `Workspace` model. It also displays `description`, `initErrorMessage`, `claudeSessions` count, etc. However, this view is the **secondary view** (toggled via ViewModeToggle; default is `board`). The table view's 15s poll can be relaxed to 30-60s and the `listWithKanbanState` cache update (which covers most of the same workspaces) provides indirect freshness. The most practical approach for the table view is to simply relax its polling interval to 30-60s as a safety net, since it's only active when `viewMode === 'list'` (already gated by `enabled: viewMode === 'list'`). The primary win is the Kanban board, which is the default view.

**Primary recommendation:** Create a `useKanbanSnapshotSync` hook (or extend the sync approach) that updates the `listWithKanbanState` React Query cache from WebSocket snapshot messages. Map snapshot entries to the `WorkspaceWithKanban` shape, merging with existing cache entries for fields not in the snapshot. Reduce Kanban polling from 15s to 30-60s. For the table view, simply relax polling to 30-60s since it's a secondary view with different data needs (full Workspace model with session counts).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `useProjectSnapshotSync` | (codebase, Phase 16) | Existing WebSocket-to-cache sync for sidebar | Established pattern; syncs `/snapshots` WS to `getProjectSummaryState` cache |
| `useWebSocketTransport` | (codebase) | WebSocket connection with auto-reconnect | All existing WS consumers use it |
| `buildWebSocketUrl` | (codebase) | Construct WS URL with query params | Used by all WS hooks |
| `trpc.useUtils()` / `setData()` | (codebase) | React Query cache manipulation | 7+ existing usages for optimistic updates |
| React Query / @tanstack/react-query | (project dep) | Data fetching + cache layer | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Vitest | (project) | Co-located unit tests | Testing mapping functions and hook behavior |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Updating `listWithKanbanState` cache via `setData` | Creating a new snapshot-only query key for kanban | Would require refactoring KanbanProvider and all consumers; `setData` on existing key is non-breaking |
| Keeping separate WS hooks per consumer | Single `useProjectSnapshotSync` that updates multiple caches | Multiple caches updated from one hook is cleaner than multiple WS connections; avoids duplicate connections |
| Adding `description`, `initErrorMessage`, `githubIssueNumber` to snapshot store | Merging with existing cache data | Adding fields to snapshot store increases its scope and memory; merge approach keeps snapshot lean |
| Full snapshot-driven table view | Relaxed polling for table view | Table view uses full Prisma model with session counts, status filtering, etc. -- too much mismatch to justify snapshot mapping |

**Installation:**
No new packages needed. All dependencies already exist in the project.

## Architecture Patterns

### Recommended Project Structure
```
src/frontend/lib/
  snapshot-to-sidebar.ts            # EXISTING: Mapping function + types (may be extended or a new file created)
  snapshot-to-kanban.ts             # NEW: Mapping function from WorkspaceSnapshotEntry to WorkspaceWithKanban
  snapshot-to-kanban.test.ts        # NEW: Tests for kanban mapping

src/frontend/hooks/
  use-project-snapshot-sync.ts      # MODIFIED: Extend to also update listWithKanbanState cache
  use-project-snapshot-sync.test.ts # MODIFIED: Add tests for kanban cache updates

src/frontend/components/kanban/
  kanban-context.tsx                # MODIFIED: Reduce refetchInterval from 15s to 30-60s

src/client/routes/projects/workspaces/
  list.tsx                          # MODIFIED: Reduce workspace.list refetchInterval from 15s to 30-60s
```

### Pattern 1: Multi-Cache Sync from Single WebSocket
**What:** Extend `useProjectSnapshotSync` to update BOTH the `getProjectSummaryState` cache (sidebar) AND the `listWithKanbanState` cache (kanban) from the same WebSocket messages. This ensures a single WebSocket connection feeds all consumers.
**When to use:** When multiple React Query caches represent overlapping data from the same source.
**Example:**
```typescript
// In useProjectSnapshotSync handleMessage callback:

// Update sidebar cache (existing)
utils.workspace.getProjectSummaryState.setData(/* ... */);

// Also update kanban cache (new)
utils.workspace.listWithKanbanState.setData(
  { projectId },
  (prev) => {
    if (!prev) return prev;
    // Map snapshot entry to WorkspaceWithKanban, merging with existing for missing fields
    // ...
  }
);
```

### Pattern 2: Snapshot-to-Kanban Mapping with Cache Merge
**What:** Map a `WorkspaceSnapshotEntry` to the `WorkspaceWithKanban` shape. For fields present in both (id, name, kanbanColumn, isWorking, prState, etc.), use snapshot values. For fields NOT in the snapshot (`description`, `initErrorMessage`, `githubIssueNumber`), merge with the existing cache entry to preserve them.
**When to use:** On every `snapshot_changed` message when updating the kanban cache.
**Example:**
```typescript
export function mapSnapshotEntryToKanbanWorkspace(
  entry: WorkspaceSnapshotEntry,
  existing?: WorkspaceWithKanban
): WorkspaceWithKanban {
  return {
    // Fields from snapshot (authoritative, real-time)
    id: entry.workspaceId,
    name: entry.name,
    status: entry.status as WorkspaceStatus,
    createdAt: new Date(entry.createdAt),
    branchName: entry.branchName,
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    prState: entry.prState,
    prCiStatus: entry.prCiStatus,
    ratchetEnabled: entry.ratchetEnabled,
    ratchetState: entry.ratchetState,
    runScriptStatus: entry.runScriptStatus,
    kanbanColumn: entry.kanbanColumn as KanbanColumn | null,
    isWorking: entry.isWorking,
    ratchetButtonAnimated: entry.ratchetButtonAnimated,
    flowPhase: entry.flowPhase,
    pendingRequestType: entry.pendingRequestType,

    // Fields NOT in snapshot — preserve from existing cache entry (or default)
    description: existing?.description ?? null,
    initErrorMessage: existing?.initErrorMessage ?? null,
    githubIssueNumber: existing?.githubIssueNumber ?? null,
    isArchived: false, // listWithKanbanState always returns false

    // Other Workspace model fields (rarely change, filled by safety-net poll)
    ...fillDefaultWorkspaceFields(existing),
  };
}
```

### Pattern 3: Kanban Column Filter in Client
**What:** The `listWithKanbanState` server procedure filters out workspaces with `kanbanColumn === null` (READY workspaces with no sessions are hidden). The same filter should be applied client-side when mapping snapshot data to the kanban cache.
**When to use:** In the `snapshot_full` and `snapshot_changed` handlers when updating the kanban cache.
**Example:**
```typescript
// Filter like the server does: exclude workspaces with null kanbanColumn
const kanbanWorkspaces = entries
  .filter(e => e.kanbanColumn !== null)
  .map(e => mapSnapshotEntryToKanbanWorkspace(e));
```

### Pattern 4: Safety-Net Polling at Reduced Cadence
**What:** Keep existing tRPC queries but reduce `refetchInterval` to 30-60s. This follows the established "event-driven + safety-net poll" pattern from Phase 16.
**When to use:** For all migrated consumers (kanban, workspace list).
**Example:**
```typescript
// KanbanProvider
trpc.workspace.listWithKanbanState.useQuery(
  { projectId },
  { refetchInterval: 30_000, staleTime: 25_000 }
);

// Workspace list (table view)
trpc.workspace.list.useQuery(
  { projectId, status },
  { enabled: viewMode === 'list', refetchInterval: 60_000, staleTime: 50_000 }
);
```

### Anti-Patterns to Avoid
- **Opening a second WebSocket connection for Kanban:** The sidebar already has a `/snapshots` WebSocket open. Do NOT open another one from KanbanProvider. Instead, extend the existing `useProjectSnapshotSync` hook (or have it update multiple caches).
- **Replacing the full Workspace model for Kanban with snapshot data only:** The KanbanCard uses fields not in the snapshot (`description`, `initErrorMessage`). Replacing the entire cache without merging loses these fields.
- **Moving `useProjectSnapshotSync` into KanbanProvider:** The hook must remain mounted in `AppSidebar` (or a shared parent) because the sidebar is always visible. The kanban board is only visible on one route. If the hook were only in KanbanProvider, the sidebar would lose real-time updates when navigating away from the kanban page.
- **Removing the `listWithKanbanState` query entirely:** The safety-net poll is needed to backfill fields not in the snapshot and to correct any missed WebSocket messages.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WebSocket connection | Custom WS logic | `useWebSocketTransport` | Already handles reconnection, backoff, cleanup |
| Cache updates | Custom state management | `utils.xxx.setData()` | Notifies all subscribers, handles deduplication |
| Kanban column derivation | Client-side column computation | Snapshot store's pre-derived `kanbanColumn` | The server already computes this; use it directly |
| Sidebar status derivation | Client-side derivation in kanban card | Snapshot store's pre-derived `sidebarStatus` | Available in snapshot; KanbanCard currently derives it locally via `deriveWorkspaceSidebarStatus` |

**Key insight:** The snapshot store already computes derived state (kanbanColumn, sidebarStatus, flowPhase, ciObservation, ratchetButtonAnimated). The Kanban card currently calls `deriveWorkspaceSidebarStatus` locally -- with snapshot data, this derivation is already done server-side and included in the entry. This is a simplification opportunity.

## Common Pitfalls

### Pitfall 1: Missing Fields on New Workspaces in Kanban
**What goes wrong:** A new workspace appears via `snapshot_changed` but has no prior cache entry to merge with. Fields like `description`, `initErrorMessage`, `githubIssueNumber` are null/undefined, and the card renders with missing data.
**Why it happens:** The snapshot doesn't include these fields, and there's no existing cache entry to merge from.
**How to avoid:** Default missing fields to sensible values (`description: null`, `initErrorMessage: null`, `githubIssueNumber: null`). These will be populated by the next safety-net poll (30-60s). Since new workspaces typically don't have descriptions or error messages yet, the visual impact is minimal.
**Warning signs:** New workspace cards showing blank description or missing status badge for a few seconds.

### Pitfall 2: Duplicate WebSocket Connections
**What goes wrong:** If `useProjectSnapshotSync` is mounted in both `AppSidebar` and `KanbanProvider`, two WebSocket connections open to the same endpoint, causing double processing of messages and potential cache race conditions.
**Why it happens:** Each hook instance creates its own WebSocket via `useWebSocketTransport`.
**How to avoid:** Keep the hook mounted in ONE place (AppSidebar, which is always rendered). Have it update both the sidebar and kanban caches. Do NOT mount a second instance in KanbanProvider.
**Warning signs:** Two `/snapshots` connections visible in browser DevTools; double `setData` calls on the same cache key.

### Pitfall 3: Kanban Cache Shape Mismatch with TypeScript
**What goes wrong:** The `listWithKanbanState` tRPC return type is inferred by TypeScript. The `setData` updater must return exactly that type. The snapshot-mapped data may not match because it lacks fields from the full Prisma `Workspace` model (e.g., `updatedAt`, `worktreePath`, `isAutoGeneratedBranch`, etc.).
**Why it happens:** `listWithKanbanState` returns `{ ...workspace }` which spreads ALL Prisma Workspace fields. The tRPC-inferred cache type includes all of them.
**How to avoid:** Use the `as never` type assertion pattern established in Phase 16 for the `setData` callback. The runtime data is functionally correct for rendering even though TypeScript can't prove the full Workspace shape. The safety-net poll periodically replaces with the complete shape.
**Warning signs:** TypeScript errors on `setData` calls; the solution is the same `as never` assertion used in Phase 16.

### Pitfall 4: Race Between WebSocket Update and Safety-Net Poll
**What goes wrong:** A WebSocket push updates the kanban cache with fresh data, but moments later the safety-net poll returns slightly stale data (the DB query is slower than the in-memory snapshot), overwriting the fresher WebSocket data.
**Why it happens:** React Query's `refetchInterval` runs independently of `setData`.
**How to avoid:** Set `staleTime` close to (but slightly below) `refetchInterval`. For example, `refetchInterval: 30_000` with `staleTime: 25_000`. After a `setData` call marks the cache as "fresh," the poll won't overwrite it for 25 seconds. This is the same approach Phase 16 uses.
**Warning signs:** Kanban cards flickering between states every 30 seconds.

### Pitfall 5: githubIssueNumber Missing Breaks Issue Filtering
**What goes wrong:** The KanbanProvider filters GitHub issues to exclude ones that already have workspaces (`workspaceIssueNumbers` set). If snapshot-driven data doesn't include `githubIssueNumber`, the filter fails and issues that already have workspaces reappear in the Issues column.
**Why it happens:** `githubIssueNumber` is not in the snapshot entry.
**How to avoid:** On `snapshot_changed`, merge `githubIssueNumber` from the existing cache entry. On `snapshot_full`, use the existing cache to backfill this field. The safety-net poll will correct any gaps. Additionally, the issues query has its own separate 60s poll that handles this concern.
**Warning signs:** Issues column showing issues that already have workspaces associated.

### Pitfall 6: Table View Data Shape Incompatibility
**What goes wrong:** Attempting to map snapshot entries to the full `Workspace` type for the table view results in many missing fields (claudeSessions count, worktreePath, updatedAt, etc.) and a degraded table display.
**Why it happens:** The table view uses the full Prisma Workspace model with session relations. The snapshot is a lean derived state.
**How to avoid:** Do NOT try to drive the table view from snapshots. Simply relax its polling interval from 15s to 30-60s. The table view is the secondary view (not the default), and it needs the full data shape. The main performance win is the Kanban board (default view).
**Warning signs:** Table view showing incomplete data or "undefined" values in columns.

## Code Examples

Verified patterns from the codebase:

### Existing Snapshot Sync Hook (Phase 16 pattern)
```typescript
// Source: src/frontend/hooks/use-project-snapshot-sync.ts

export function useProjectSnapshotSync(projectId: string | undefined): void {
  const utils = trpc.useUtils();
  const url = projectId ? buildWebSocketUrl('/snapshots', { projectId }) : null;

  const handleMessage = useCallback(
    (data: unknown) => {
      const message = data as SnapshotServerMessage;
      const { setData } = utils.workspace.getProjectSummaryState;

      switch (message.type) {
        case 'snapshot_full': {
          setData({ projectId: message.projectId }, ((prev) => ({
            workspaces: message.entries.map(mapSnapshotEntryToServerWorkspace),
            reviewCount: prev?.reviewCount ?? 0,
          })) as never);
          break;
        }
        // ... snapshot_changed and snapshot_removed handlers
      }
    },
    [projectId, utils]
  );

  useWebSocketTransport({ url, onMessage: handleMessage, queuePolicy: 'drop' });
}
```

### Current Kanban Data Fetch (what we're supplementing)
```typescript
// Source: src/frontend/components/kanban/kanban-context.tsx (lines 48-57)

const {
  data: workspaces,
  isLoading: isLoadingWorkspaces,
  isError: isErrorWorkspaces,
  error: errorWorkspaces,
  refetch: refetchWorkspaces,
} = trpc.workspace.listWithKanbanState.useQuery(
  { projectId },
  { refetchInterval: 15_000, staleTime: 10_000 }
);
```

### WorkspaceWithKanban Type (Kanban card's data requirement)
```typescript
// Source: src/frontend/components/kanban/kanban-card.tsx (lines 19-26)

export interface WorkspaceWithKanban extends Workspace {
  kanbanColumn: KanbanColumn | null;
  isWorking: boolean;
  ratchetButtonAnimated?: boolean;
  flowPhase?: string | null;
  isArchived?: boolean;
  pendingRequestType?: 'plan_approval' | 'user_question' | null;
}
```

### Fields KanbanCard Uses from Full Workspace Model
```typescript
// Source: Analysis of src/frontend/components/kanban/kanban-card.tsx

// Fields from WorkspaceWithKanban (extends Workspace):
// - workspace.id                 (in snapshot as workspaceId)
// - workspace.name               (in snapshot)
// - workspace.status             (in snapshot)
// - workspace.branchName         (in snapshot)
// - workspace.prUrl              (in snapshot)
// - workspace.prNumber           (in snapshot)
// - workspace.prState            (in snapshot)
// - workspace.prCiStatus         (in snapshot)
// - workspace.ratchetEnabled     (in snapshot)
// - workspace.ratchetState       (in snapshot)
// - workspace.runScriptStatus    (in snapshot)
// - workspace.kanbanColumn       (in snapshot)
// - workspace.isWorking          (in snapshot)
// - workspace.ratchetButtonAnimated (in snapshot)
// - workspace.pendingRequestType (in snapshot)

// Fields from Workspace NOT in snapshot:
// - workspace.description        (optional card text; rarely set on creation)
// - workspace.initErrorMessage   (error badge; only set on FAILED status)
// - workspace.isArchived         (always false in listWithKanbanState)

// Field used in KanbanProvider NOT in snapshot:
// - workspace.githubIssueNumber  (used to filter issues column)
```

### Sidebar Consumer Data Flow (established in Phase 16)
```
AppSidebar
  -> useProjectSnapshotSync(selectedProjectId)       // WebSocket -> cache
  -> trpc.workspace.getProjectSummaryState.useQuery() // safety-net poll @ 30s
  -> returns { workspaces: ServerWorkspace[], reviewCount }
  -> workspaces passed to useWorkspaceListState()
  -> rendered by WorkspaceList -> SortableWorkspaceItem
```

### Kanban Consumer Data Flow (current, to be updated)
```
WorkspacesListPage (default view: board)
  -> <WorkspacesBoardView>
     -> <KanbanProvider projectId={projectId}>
        -> trpc.workspace.listWithKanbanState.useQuery() @ 15s poll
        -> trpc.github.listIssuesForProject.useQuery() @ 60s poll
        -> filters issues by workspace.githubIssueNumber
        -> <KanbanBoard>
           -> workspaces grouped by kanbanColumn
           -> <KanbanColumn> -> <KanbanCard>
```

### Table View Consumer Data Flow (secondary view)
```
WorkspacesListPage (when viewMode === 'list')
  -> <WorkspacesTableView>
     -> trpc.workspace.list.useQuery() @ 15s poll (enabled only when viewMode === 'list')
     -> renders full table with name, status, sessions, branch, created date
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Kanban polls `listWithKanbanState` at 15s | WebSocket push + 30-60s safety-net poll | Phase 17 | ~200ms kanban column updates instead of 0-15s |
| Workspace list polls `workspace.list` at 15s | 30-60s safety-net poll (table view only) | Phase 17 | Reduced server load; table view is secondary |
| Only sidebar uses WebSocket snapshots | Sidebar + kanban both use snapshots | Phase 16 -> 17 | All project-level workspace surfaces share consistent real-time state |

## Open Questions

1. **Should `useProjectSnapshotSync` be split into two hooks or remain one?**
   - What we know: Currently the hook only updates `getProjectSummaryState` cache. It needs to also update `listWithKanbanState` cache.
   - What's unclear: Whether extending the single hook keeps it clean enough or if a second hook (sharing the same WS connection) is better.
   - Recommendation: **Extend the single hook.** Adding a second `setData` call per message type is straightforward (~20 lines per message type). A second hook would require a second WebSocket connection (wasteful) or a shared connection abstraction (over-engineering). The single hook already has access to `utils` which exposes both cache keys.

2. **Should we add `description`, `initErrorMessage`, `githubIssueNumber` to the snapshot store?**
   - What we know: These fields are used by KanbanCard but not in the snapshot. They could be added to `WorkspaceSnapshotEntry` and `SnapshotUpdateInput`.
   - What's unclear: Whether the added complexity (more fields to track, more reconciliation surface) is worth it vs. the merge-from-cache approach.
   - Recommendation: **Do NOT add them to the snapshot store in this phase.** The merge-from-cache approach works well because: (a) `description` rarely changes after creation, (b) `initErrorMessage` only applies to FAILED workspaces which are brief transient states, (c) `githubIssueNumber` never changes after workspace creation. The safety-net poll handles the initial population. This keeps the snapshot store lean and focused on real-time state. If these fields prove problematic, they can be added to the snapshot store in a future phase.

3. **Should the `listWithKanbanState` setData use the full Prisma Workspace shape or a partial type?**
   - What we know: The tRPC-inferred cache type expects the full spread of `{ ...workspace }` (all Prisma Workspace fields) plus the computed kanban fields. The snapshot only covers a subset.
   - What's unclear: Whether TypeScript will accept a partial shape via `setData`.
   - Recommendation: **Use `as never` type assertion** (same as Phase 16). The runtime rendering only accesses the fields listed in the code examples above. The missing fields (`updatedAt`, `worktreePath`, `isAutoGeneratedBranch`, etc.) are not used by KanbanCard or KanbanColumn. The assertion is safe in practice and the safety-net poll periodically replaces with the complete shape.

4. **Where does the `useProjectSnapshotSync` hook remain mounted?**
   - What we know: It's currently in `AppSidebar`. The sidebar is always rendered when a project is selected.
   - What's unclear: Whether it should be lifted to a shared project-level layout component.
   - Recommendation: **Keep it in `AppSidebar`.** The sidebar is always visible when viewing project content (it wraps both the workspace detail and kanban views). Lifting it to a layout component adds routing complexity for no benefit. The hook already has access to `selectedProjectId` from the sidebar's project selection logic.

## Sources

### Primary (HIGH confidence)
- **Codebase analysis:** `src/frontend/hooks/use-project-snapshot-sync.ts` -- Phase 16 sync hook (the pattern being extended)
- **Codebase analysis:** `src/frontend/lib/snapshot-to-sidebar.ts` -- Mapping function and client-side snapshot types
- **Codebase analysis:** `src/frontend/components/kanban/kanban-context.tsx` -- KanbanProvider with 15s `listWithKanbanState` poll, issue filtering by `githubIssueNumber`
- **Codebase analysis:** `src/frontend/components/kanban/kanban-card.tsx` -- `WorkspaceWithKanban` type definition, all fields accessed in rendering
- **Codebase analysis:** `src/frontend/components/kanban/kanban-board.tsx` -- Workspace grouping by `kanbanColumn`, column rendering
- **Codebase analysis:** `src/frontend/components/kanban/kanban-column.tsx` -- Column config and card rendering
- **Codebase analysis:** `src/client/routes/projects/workspaces/list.tsx` -- WorkspacesListPage with board/list view toggle, `workspace.list` query at 15s
- **Codebase analysis:** `src/client/routes/projects/workspaces/components/workspaces-table-view.tsx` -- Table view consuming full Workspace model with sessions
- **Codebase analysis:** `src/client/routes/projects/workspaces/components/workspaces-board-view.tsx` -- Board view wrapping KanbanProvider
- **Codebase analysis:** `src/backend/services/workspace-snapshot-store.service.ts` -- `WorkspaceSnapshotEntry` type (lines 74-123), fields available
- **Codebase analysis:** `src/backend/domains/workspace/query/workspace-query.service.ts` -- `listWithKanbanState` return shape (lines 260-275): `{ ...workspace, kanbanColumn, isWorking, ratchetButtonAnimated, flowPhase, ciObservation, isArchived: false, pendingRequestType }`
- **Codebase analysis:** `src/frontend/components/use-workspace-list-state.ts` -- `ServerWorkspace` type used by sidebar
- **Codebase analysis:** `src/frontend/components/app-sidebar.tsx` -- Where `useProjectSnapshotSync` is mounted, `getProjectSummaryState` at 30s safety-net

### Secondary (MEDIUM confidence)
- **Phase 16 docs:** `.planning/phases/16-client-integration-sidebar/16-01-SUMMARY.md` -- Implementation decisions, `as never` pattern, client-side type strategy
- **Phase 16 docs:** `.planning/phases/16-client-integration-sidebar/16-RESEARCH.md` -- Architecture patterns, pitfalls, anti-patterns
- **Codebase analysis:** `prisma/schema.prisma` -- Full Workspace model definition (all fields)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- exclusively reuses Phase 16 patterns (same hook, same libraries, same cache update approach)
- Architecture: HIGH -- extending proven `setData` pattern to a second cache key; shape mismatch well-understood through field-by-field analysis
- Pitfalls: HIGH -- derived from direct comparison of `WorkspaceSnapshotEntry` vs `WorkspaceWithKanban` field usage; race condition and type assertion patterns already solved in Phase 16

**Key data shape analysis:**
- KanbanCard uses 18 fields from `WorkspaceWithKanban`
- Of those, 15 are present in `WorkspaceSnapshotEntry` (the real-time ones)
- 3 are NOT in snapshot: `description` (optional text), `initErrorMessage` (transient error), `githubIssueNumber` (static after creation)
- All 3 missing fields are either rarely used, static after creation, or backfilled by safety-net poll
- Conclusion: Snapshot data covers all real-time rendering needs; missing fields are acceptable gaps

**Research date:** 2026-02-11
**Valid until:** 2026-03-11 (stable domain -- all components are internal codebase patterns)
