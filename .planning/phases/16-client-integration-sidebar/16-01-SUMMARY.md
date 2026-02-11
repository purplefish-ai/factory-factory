---
phase: 16-client-integration-sidebar
plan: 01
subsystem: ui
tags: [react, websocket, react-query, trpc, sidebar, real-time]

# Dependency graph
requires:
  - phase: 15-websocket-transport
    provides: /snapshots WebSocket endpoint with snapshot_full, snapshot_changed, snapshot_removed messages
provides:
  - useProjectSnapshotSync hook syncing WebSocket snapshots to React Query cache
  - mapSnapshotEntryToServerWorkspace pure mapping function
  - Client-side WorkspaceSnapshotEntry type and SnapshotServerMessage discriminated union
  - Vite /snapshots WebSocket proxy for development
affects: [17-client-integration-kanban]

# Tech tracking
tech-stack:
  added: []
  patterns: [receive-only WebSocket hook with drop queue policy, tRPC setData for WebSocket-driven cache updates]

key-files:
  created:
    - src/frontend/lib/snapshot-to-sidebar.ts
    - src/frontend/lib/snapshot-to-sidebar.test.ts
    - src/frontend/hooks/use-project-snapshot-sync.ts
    - src/frontend/hooks/use-project-snapshot-sync.test.ts
  modified:
    - src/frontend/components/app-sidebar.tsx
    - vite.config.ts

key-decisions:
  - "Client-side WorkspaceSnapshotEntry type defined locally (not imported from backend) to respect frontend/backend build boundary"
  - "Type assertion (as never) on setData updaters to bypass tRPC strict inference for createdAt: string|Date vs Date"
  - "createdAt converted to Date in mapping function to match tRPC-inferred cache type from superjson"
  - "Simplified workspacePendingArchive ternary to keep AppSidebar under Biome complexity limit"

patterns-established:
  - "WebSocket-to-cache sync: receive-only hook with drop policy + setData updaters for tRPC cache injection"
  - "Frontend snapshot types: local type mirrors for backend types that can't be imported across build boundaries"

# Metrics
duration: 10min
completed: 2026-02-11
---

# Phase 16 Plan 01: Client Integration Sidebar Summary

**WebSocket-driven sidebar updates via useProjectSnapshotSync hook replacing 2s tRPC polling with real-time snapshots and 30s safety-net poll**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-11T18:40:58Z
- **Completed:** 2026-02-11T18:51:55Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Pure mapping function `mapSnapshotEntryToServerWorkspace` correctly transforms all 21 fields from WorkspaceSnapshotEntry to ServerWorkspace shape, with field renames (workspaceId->id, kanbanColumn->cachedKanbanColumn, computedAt->stateComputedAt) and Date conversion
- `useProjectSnapshotSync` hook handles all three message types (snapshot_full, snapshot_changed, snapshot_removed) and updates React Query cache via setData, preserving reviewCount across all updates
- Sidebar polling interval reduced from 2 seconds to 30 seconds as a safety net, with WebSocket providing real-time updates
- Vite dev server proxies /snapshots WebSocket connections to the backend

## Task Commits

Each task was committed atomically:

1. **Task 1: Create snapshot-to-sidebar mapping function and sync hook with tests** - `325063e` (feat)
2. **Task 2: Wire sync hook into AppSidebar and add Vite proxy** - `de39a81` (feat)

## Files Created/Modified
- `src/frontend/lib/snapshot-to-sidebar.ts` - Pure mapping function and client-side snapshot message types
- `src/frontend/lib/snapshot-to-sidebar.test.ts` - 7 tests for mapping function (field renames, passthrough, exclusions)
- `src/frontend/hooks/use-project-snapshot-sync.ts` - React hook syncing /snapshots WebSocket to React Query cache
- `src/frontend/hooks/use-project-snapshot-sync.test.ts` - 10 tests for hook behavior (all message types, deferred connection)
- `src/frontend/components/app-sidebar.tsx` - Mount sync hook, reduce polling to 30s safety-net
- `vite.config.ts` - Add /snapshots WebSocket proxy entry

## Decisions Made
- Defined WorkspaceSnapshotEntry type locally in the frontend rather than importing from @/backend service, maintaining the frontend/backend build boundary. This is consistent with how the codebase handles cross-boundary types (only AppRouter is imported via relative path for tRPC inference).
- Used `as never` type assertion on setData updater callbacks because ServerWorkspace declares `createdAt: string | Date` while the tRPC-inferred cache type expects `Date`. The mapping function converts to Date, making the runtime values compatible.
- Simplified the `workspacePendingArchive` ternary in AppSidebar (removed null guard, using find's natural undefined return) to keep the component under Biome's cognitive complexity limit of 15 after adding the new hook call.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Client-side type definition instead of backend import**
- **Found during:** Task 1 (mapping function creation)
- **Issue:** Plan specified `import type { WorkspaceSnapshotEntry } from '@/backend/services/workspace-snapshot-store.service'` but frontend code cannot import from @/backend (separate build boundary, would pull in Node.js modules)
- **Fix:** Defined WorkspaceSnapshotEntry interface locally in snapshot-to-sidebar.ts, mirroring the server type
- **Files modified:** src/frontend/lib/snapshot-to-sidebar.ts
- **Verification:** TypeScript compiles, tests pass, no cross-boundary imports
- **Committed in:** 325063e (Task 1 commit)

**2. [Rule 1 - Bug] Fixed WorkspaceSidebarStatus type in test factories**
- **Found during:** Task 1 (test creation)
- **Issue:** Test factories used `{ label, variant }` shape but actual WorkspaceSidebarStatus interface has `{ activityState, ciState }`
- **Fix:** Updated test factories to use correct field names
- **Files modified:** src/frontend/lib/snapshot-to-sidebar.test.ts, src/frontend/hooks/use-project-snapshot-sync.test.ts
- **Verification:** TypeScript compiles, all 17 tests pass
- **Committed in:** 325063e (Task 1 commit)

**3. [Rule 1 - Bug] Fixed createdAt type mismatch between ServerWorkspace and tRPC cache**
- **Found during:** Task 1 (typecheck after mapping function)
- **Issue:** ServerWorkspace.createdAt is `string | Date` but tRPC-inferred cache type expects `Date` (from superjson). setData updater type check failed.
- **Fix:** Mapping function converts createdAt string to Date; used `as never` assertion on updater callbacks
- **Files modified:** src/frontend/lib/snapshot-to-sidebar.ts, src/frontend/hooks/use-project-snapshot-sync.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** 325063e (Task 1 commit)

**4. [Rule 3 - Blocking] Reduced AppSidebar cognitive complexity to stay under Biome limit**
- **Found during:** Task 2 (wiring hook into AppSidebar)
- **Issue:** Adding the hook call with ternary pushed AppSidebar from complexity 15 to 17, exceeding Biome's max of 15
- **Fix:** Simplified workspacePendingArchive ternary (removed guard, using find's undefined return) to recover 1 point, and simplified hook call ternary to recover another
- **Files modified:** src/frontend/components/app-sidebar.tsx
- **Verification:** pnpm check:fix passes
- **Committed in:** de39a81 (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (2 bugs, 2 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and build compliance. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- WebSocket-to-cache pipeline fully operational for sidebar
- Phase 17 (kanban integration) can follow the same pattern using useProjectSnapshotSync as a reference
- All 2041 tests passing, zero regressions

---
*Phase: 16-client-integration-sidebar*
*Completed: 2026-02-11*
