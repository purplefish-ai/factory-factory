---
phase: 13-event-collector
plan: 01
subsystem: orchestration
tags: [event-emitter, debounce, coalescing, snapshot-store, domain-events]

# Dependency graph
requires:
  - phase: 11-snapshot-store
    provides: WorkspaceSnapshotStore with upsert/remove/getByWorkspaceId API
  - phase: 12-domain-event-emission
    provides: Typed EventEmitter events from all 5 domains (workspace, github, ratchet, run-script, workspace-activity)
provides:
  - EventCoalescer class for per-workspace debounced event coalescing
  - configureEventCollector() wiring all 6 domain events to snapshot store
  - stopEventCollector() for clean shutdown with pending flush
  - Server startup/shutdown integration
affects: [14-reconciliation-poll, 15-websocket-transport, 16-client-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [per-workspace-debounce-coalescing, orchestration-event-subscription, trailing-edge-debounce]

key-files:
  created:
    - src/backend/orchestration/event-collector.orchestrator.ts
    - src/backend/orchestration/event-collector.orchestrator.test.ts
  modified:
    - src/backend/server.ts

key-decisions:
  - "150ms trailing-edge debounce for coalescing window (middle of 100-200ms requirement)"
  - "ARCHIVED events bypass coalescer for immediate store.remove() and instant UI feedback"
  - "Unknown workspaces (not in store, no projectId) silently skipped -- reconciliation seeds them"
  - "Event collector NOT re-exported from orchestration/index.ts to avoid circular deps"

patterns-established:
  - "Orchestration event subscriber: subscribe to domain EventEmitter from orchestration layer, never from domains themselves"
  - "Coalescing buffer pattern: Map<id, {fields, sources, timer}> with clearTimeout/setTimeout debounce"
  - "Source string concatenation: coalesced sources joined with '+' for debug observability"

# Metrics
duration: 5min
completed: 2026-02-11
---

# Phase 13 Plan 01: Event Collector Summary

**Per-workspace coalescing event collector subscribing to 6 domain events with 150ms debounce window, ARCHIVED bypass, and unknown-workspace guard**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-11T17:04:33Z
- **Completed:** 2026-02-11T17:09:33Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- EventCoalescer class that accumulates SnapshotUpdateInput fields per workspace and flushes after 150ms debounce
- configureEventCollector() subscribes to all 6 domain events with correct field mapping (no prReviewState leakage)
- ARCHIVED workspace events trigger immediate store.remove() without coalescing delay
- Unknown workspaces (not yet seeded by reconciliation) gracefully skipped
- Clean shutdown via stopEventCollector() flushes all pending coalesced updates
- 19 tests covering coalescing behavior, field mapping, edge cases, and wiring

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement EventCoalescer and configureEventCollector with tests** - `4cddf02` (feat)
2. **Task 2: Wire event collector into server startup and shutdown** - `97903b0` (feat)

## Files Created/Modified
- `src/backend/orchestration/event-collector.orchestrator.ts` - EventCoalescer class, configureEventCollector(), stopEventCollector()
- `src/backend/orchestration/event-collector.orchestrator.test.ts` - 19 tests for coalescing, field mapping, wiring, and edge cases
- `src/backend/server.ts` - Import + startup call after configureDomainBridges() + shutdown call before ratchetService.stop()

## Decisions Made
- 150ms debounce window chosen as midpoint of 100-200ms requirement range
- ARCHIVED events bypass coalescer entirely -- call store.remove() synchronously for instant UI feedback
- Unknown workspaces silently skipped (not error) -- reconciliation in Phase 14 will seed them
- Event collector imported directly from module path, NOT re-exported from orchestration/index.ts (following existing circular dep avoidance pattern per comment in index.ts)
- StoreInterface exported for test type safety

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed invalid RatchetState enum value in tests**
- **Found during:** Task 1 (test creation)
- **Issue:** Plan research used 'MONITORING' as example RatchetState but valid values are IDLE, CI_RUNNING, CI_FAILED, REVIEW_PENDING, READY, MERGED
- **Fix:** Replaced 'MONITORING' with 'CI_RUNNING' in test assertions
- **Files modified:** src/backend/orchestration/event-collector.orchestrator.test.ts
- **Verification:** TypeScript compilation passes, tests pass
- **Committed in:** 4cddf02 (Task 1 commit)

**2. [Rule 1 - Bug] Fixed Biome lint: block statements required for early return**
- **Found during:** Task 1 (lint check)
- **Issue:** `if (!pending) return;` style violates Biome useBlockStatements rule
- **Fix:** Changed to `if (!pending) { return; }`
- **Files modified:** src/backend/orchestration/event-collector.orchestrator.ts
- **Verification:** pnpm check:fix passes clean
- **Committed in:** 4cddf02 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 bug fixes)
**Impact on plan:** Minor corrections for type safety and lint compliance. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Event collector is wired and active -- domain events now flow to snapshot store via coalescing buffer
- Phase 14 (reconciliation poll) can build the safety-net polling that seeds workspaces the event collector skips
- Phase 15 (WebSocket transport) can subscribe to store SNAPSHOT_CHANGED events for push delivery

## Self-Check: PASSED

All files exist. All commits verified.

---
*Phase: 13-event-collector*
*Completed: 2026-02-11*
