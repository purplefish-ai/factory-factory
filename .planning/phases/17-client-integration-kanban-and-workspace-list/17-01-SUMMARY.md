---
phase: 17-client-integration-kanban-and-workspace-list
plan: 01
subsystem: ui
tags: [react-query, websocket, kanban, cache-sync, polling]

# Dependency graph
requires:
  - phase: 16-client-integration-sidebar
    provides: "useProjectSnapshotSync hook, snapshot-to-sidebar mapping, WorkspaceSnapshotEntry type"
provides:
  - "mapSnapshotEntryToKanbanWorkspace mapping function for kanban cache"
  - "WebSocket-driven kanban cache updates via listWithKanbanState.setData"
  - "Reduced polling cadences: kanban 30s, table view 60s"
affects: [client-integration, kanban-board, workspace-list]

# Tech tracking
tech-stack:
  added: []
  patterns: ["extracted cache updater helpers to satisfy Biome complexity limits"]

key-files:
  created:
    - src/frontend/lib/snapshot-to-kanban.ts
    - src/frontend/lib/snapshot-to-kanban.test.ts
  modified:
    - src/frontend/hooks/use-project-snapshot-sync.ts
    - src/frontend/hooks/use-project-snapshot-sync.test.ts
    - src/frontend/components/kanban/kanban-context.tsx
    - src/client/routes/projects/workspaces/list.tsx

key-decisions:
  - "Extracted kanban cache helper functions (buildKanbanCacheFromFull, upsertKanbanCacheEntry, removeFromKanbanCache) to keep handleMessage under Biome cognitive complexity limit of 15"
  - "Kanban cache entries with null kanbanColumn are filtered out (matching server listWithKanbanState behavior)"
  - "Non-snapshot fields (description, initErrorMessage, githubIssueNumber) merged from existing cache entries to avoid data loss on WebSocket update"

patterns-established:
  - "Cache helper extraction: complex setData updaters extracted as pure functions to satisfy lint complexity limits"

# Metrics
duration: 5min
completed: 2026-02-11
---

# Phase 17 Plan 01: Client Integration - Kanban and Workspace List Summary

**WebSocket-driven kanban cache sync via mapSnapshotEntryToKanbanWorkspace with reduced polling (30s kanban, 60s table)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-11T19:14:09Z
- **Completed:** 2026-02-11T19:19:30Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Created snapshot-to-kanban mapping function that transforms WebSocket snapshot entries to the kanban workspace shape, merging non-snapshot fields from existing cache
- Extended useProjectSnapshotSync hook to update both sidebar and kanban React Query caches from a single WebSocket connection
- Reduced kanban polling from 15s to 30s and table view polling from 15s to 60s

## Task Commits

Each task was committed atomically:

1. **Task 1: Create snapshot-to-kanban mapping function with tests** - `8a8ac13` (feat)
2. **Task 2: Extend sync hook to update kanban cache and reduce polling cadences** - `52156e9` (feat)

## Files Created/Modified
- `src/frontend/lib/snapshot-to-kanban.ts` - Maps WorkspaceSnapshotEntry to kanban workspace shape (Record<string, unknown>)
- `src/frontend/lib/snapshot-to-kanban.test.ts` - 9 tests for kanban mapping function
- `src/frontend/hooks/use-project-snapshot-sync.ts` - Extended to update listWithKanbanState cache alongside sidebar cache
- `src/frontend/hooks/use-project-snapshot-sync.test.ts` - 20 tests (9 sidebar + 11 kanban cache tests)
- `src/frontend/components/kanban/kanban-context.tsx` - Reduced refetchInterval to 30s, staleTime to 25s
- `src/client/routes/projects/workspaces/list.tsx` - Reduced refetchInterval to 60s, staleTime to 50s

## Decisions Made
- Extracted 3 kanban cache helper functions (buildKanbanCacheFromFull, upsertKanbanCacheEntry, removeFromKanbanCache) to keep handleMessage under Biome's cognitive complexity limit of 15
- Entries with null kanbanColumn are filtered out of the kanban cache (matching server-side listWithKanbanState behavior where READY workspaces with no sessions are hidden)
- Non-snapshot fields (description, initErrorMessage, githubIssueNumber) are merged from existing cache entries to preserve data that only comes from the initial tRPC query

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extracted kanban cache updaters to satisfy Biome complexity limit**
- **Found during:** Task 2 (Extend sync hook)
- **Issue:** Adding kanban cache updates inline in handleMessage pushed cognitive complexity to 18 (limit: 15), and inline `if (!prev) return prev;` violated Biome's `useBlockStatements` rule
- **Fix:** Extracted three pure helper functions: `buildKanbanCacheFromFull`, `upsertKanbanCacheEntry`, `removeFromKanbanCache`
- **Files modified:** src/frontend/hooks/use-project-snapshot-sync.ts
- **Verification:** `pnpm check:fix` passes with zero errors
- **Committed in:** 52156e9 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Refactoring was necessary to satisfy existing lint rules. No scope creep -- same functionality, cleaner structure.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three project surfaces (sidebar, kanban, table) now receive consistent workspace state
- Sidebar and kanban receive real-time updates via WebSocket (~200ms)
- Table view maintains relaxed 60s polling (not snapshot-driven, as planned)
- Ready for Phase 18 or any further client integration work

## Self-Check: PASSED

- All 7 files verified present on disk
- Both task commits (8a8ac13, 52156e9) verified in git log
- Full test suite: 2061 tests passing across 111 files
- TypeScript: zero type errors
- Biome: zero lint/format violations
- Dependency-cruiser: zero violations

---
*Phase: 17-client-integration-kanban-and-workspace-list*
*Completed: 2026-02-11*
