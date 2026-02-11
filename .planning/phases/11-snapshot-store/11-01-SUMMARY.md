---
phase: 11-snapshot-store
plan: 01
subsystem: backend
tags: [in-memory-store, event-emitter, snapshot, field-timestamps, derivation]

# Dependency graph
requires:
  - phase: none
    provides: Existing workspace domain pure functions (deriveWorkspaceFlowState, computeKanbanColumn, deriveWorkspaceSidebarStatus)
provides:
  - WorkspaceSnapshotStore service with versioned per-workspace in-memory store
  - Type definitions for snapshot entries, update inputs, derivation functions
  - EventEmitter-based change notifications (snapshot_changed, snapshot_removed)
  - Field-level timestamp merging for concurrent update safety
  - Derivation function injection via domain-bridges orchestrator
affects: [11-02-snapshot-store, event-collection, reconciliation, websocket-transport, client-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [field-level-timestamp-merge, derivation-function-injection, grouped-field-timestamps]

key-files:
  created:
    - src/backend/services/workspace-snapshot-store.service.ts
  modified:
    - src/backend/services/index.ts
    - src/backend/orchestration/domain-bridges.orchestrator.ts

key-decisions:
  - "Duplicate WorkspaceFlowPhase and WorkspaceCiObservation types in store file to maintain ARCH-02 zero-domain-import compliance"
  - "Field timestamps grouped by update source (workspace, pr, session, ratchet, runScript, reconciliation) not per-field"
  - "Effective isWorking computed as session activity OR flow-state working for kanban/sidebar derivation"

patterns-established:
  - "Field-level timestamp merge: group related fields by update source, compare timestamps per group"
  - "Derivation function injection: store accepts callback functions via configure() to avoid domain imports"
  - "Project index: secondary Map<projectId, Set<workspaceId>> for efficient project-level queries"

# Metrics
duration: 12min
completed: 2026-02-11
---

# Phase 11 Plan 01: Snapshot Store Summary

**Versioned per-workspace in-memory WorkspaceSnapshotStore with field-level timestamp merging, injected derivation functions, and EventEmitter change notifications**

## Performance

- **Duration:** 12 min
- **Started:** 2026-02-11T14:48:53Z
- **Completed:** 2026-02-11T15:00:44Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created WorkspaceSnapshotStore service (556 lines) with full CRUD operations, field-level timestamp merging, and derived state recomputation
- Exported all types and singleton from services barrel for consumer access
- Wired derivation functions (deriveFlowState, computeKanbanColumn, deriveSidebarStatus) via domain-bridges orchestrator with string-to-Date adapter for prUpdatedAt

## Task Commits

Each task was committed atomically:

1. **Task 1: Create WorkspaceSnapshotStore service with types, class, and all methods** - `303a510` (feat)
2. **Task 2: Add barrel export and wire derivation functions via domain-bridges** - `412aac9` (feat)

## Files Created/Modified
- `src/backend/services/workspace-snapshot-store.service.ts` - Core snapshot store: types, class, singleton export (556 lines)
- `src/backend/services/index.ts` - Barrel export of snapshot store types and singleton
- `src/backend/orchestration/domain-bridges.orchestrator.ts` - Derivation function injection via configure()

## Decisions Made
- Duplicated `WorkspaceFlowPhase` and `WorkspaceCiObservation` type definitions directly in the store file rather than importing from workspace domain, maintaining strict ARCH-02 compliance (zero domain imports in services/)
- Grouped field timestamps by update source (6 groups) rather than per-field, matching research recommendation for practical concurrent update safety
- Computed effective `isWorking` as the OR of session activity and flow-state working, consistent with existing KanbanStateService pattern

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Refactored upsert() to reduce Biome cognitive complexity**
- **Found during:** Task 1 (WorkspaceSnapshotStore creation)
- **Issue:** Biome flagged upsert() with cognitive complexity 25 (max: 15)
- **Fix:** Extracted four private helper methods: createDefaultEntry(), mergeFieldGroups(), recomputeDerivedState(), updateProjectIndex()
- **Files modified:** src/backend/services/workspace-snapshot-store.service.ts
- **Verification:** `pnpm check:fix` passes with zero errors
- **Committed in:** 303a510 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Refactoring was required to pass linting. No scope creep -- all logic preserved, just decomposed into helper methods.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Snapshot store is ready for Plan 02 (tests) and subsequent phases (event collection, reconciliation)
- All derivation functions are wired and ready for use
- EventEmitter events (snapshot_changed, snapshot_removed) are available for WebSocket transport layer

## Self-Check: PASSED

All files verified present, all commits verified in git log.

---
*Phase: 11-snapshot-store*
*Completed: 2026-02-11*
