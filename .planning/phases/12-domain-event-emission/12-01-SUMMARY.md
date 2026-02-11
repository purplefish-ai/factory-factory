---
phase: 12-domain-event-emission
plan: 01
subsystem: api
tags: [EventEmitter, state-machine, domain-events, CAS, workspace, run-script]

# Dependency graph
requires:
  - phase: 11-snapshot-store
    provides: "Snapshot store infrastructure (ARCH-02 zero-domain-import pattern)"
provides:
  - "WorkspaceStateMachineService extends EventEmitter, emits WORKSPACE_STATE_CHANGED"
  - "RunScriptStateMachineService extends EventEmitter, emits RUN_SCRIPT_STATUS_CHANGED"
  - "Typed event constants and payload interfaces exported from domain barrels"
affects: [12-02-PLAN, 13-event-collector, snapshot-store-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [EventEmitter-based domain event emission after CAS mutations]

key-files:
  modified:
    - src/backend/domains/workspace/lifecycle/state-machine.service.ts
    - src/backend/domains/workspace/lifecycle/state-machine.service.test.ts
    - src/backend/domains/workspace/index.ts
    - src/backend/domains/run-script/run-script-state-machine.service.ts
    - src/backend/domains/run-script/run-script-state-machine.service.test.ts
    - src/backend/domains/run-script/index.ts

key-decisions:
  - "Events emitted AFTER successful CAS mutation, never before or on failure"
  - "EventEmitter pattern chosen over custom pub/sub for simplicity and Node.js native support"

patterns-established:
  - "Domain event emission: extend EventEmitter, emit typed constant after successful CAS, export constant + payload type from barrel"
  - "Event test pattern: collect events via listener array, assert length and payload, removeAllListeners in afterEach"

# Metrics
duration: 3min
completed: 2026-02-11
---

# Phase 12 Plan 01: Domain Event Emission Summary

**EventEmitter-based state change events on workspace and run-script state machines with typed constants and 11 emission/non-emission tests**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-11T16:20:29Z
- **Completed:** 2026-02-11T16:24:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- WorkspaceStateMachineService extends EventEmitter, emits WORKSPACE_STATE_CHANGED on all 3 mutation paths (transition, startProvisioning FAILED path, resetToNew)
- RunScriptStateMachineService extends EventEmitter, emits RUN_SCRIPT_STATUS_CHANGED on transition() (all other methods delegate to transition)
- 11 new tests verifying emission on success and non-emission on CAS failure, invalid transition, and max retry exceeded
- Event constants and payload types exported from domain barrels for downstream consumers

## Task Commits

Each task was committed atomically:

1. **Task 1: Add event emission to workspace and run-script state machines** - `f1ed474` (feat)
2. **Task 2: Add event emission tests for workspace and run-script state machines** - `e5b91af` (test)

**Plan metadata:** `a81df9b` (docs: complete plan)

## Files Created/Modified
- `src/backend/domains/workspace/lifecycle/state-machine.service.ts` - Extended EventEmitter, added WORKSPACE_STATE_CHANGED constant, WorkspaceStateChangedEvent type, emit calls in transition(), startProvisioning(), resetToNew()
- `src/backend/domains/workspace/index.ts` - Barrel exports for WORKSPACE_STATE_CHANGED and WorkspaceStateChangedEvent
- `src/backend/domains/run-script/run-script-state-machine.service.ts` - Extended EventEmitter, added RUN_SCRIPT_STATUS_CHANGED constant, RunScriptStatusChangedEvent type, emit call in transition()
- `src/backend/domains/run-script/index.ts` - Barrel exports for RUN_SCRIPT_STATUS_CHANGED and RunScriptStatusChangedEvent
- `src/backend/domains/workspace/lifecycle/state-machine.service.test.ts` - 7 event emission tests
- `src/backend/domains/run-script/run-script-state-machine.service.test.ts` - 4 event emission tests

## Decisions Made
- Events emitted AFTER successful CAS mutation, never before or on failure -- ensures consumers only see committed state changes
- EventEmitter pattern (Node.js native) chosen over custom pub/sub for simplicity and zero new dependencies

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Both state machines now emit typed events that downstream consumers (Phase 13 Event Collector) can subscribe to
- Event constants and payload types are available from domain barrels for type-safe event handling
- Ready for Plan 02 (session state machine event emission) and Phase 13 (event collector wiring)

## Self-Check: PASSED

All 6 modified files verified present. Both task commits (f1ed474, e5b91af) verified in git log.

---
*Phase: 12-domain-event-emission*
*Completed: 2026-02-11*
