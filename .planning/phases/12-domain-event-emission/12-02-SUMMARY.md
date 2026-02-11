---
phase: 12-domain-event-emission
plan: 02
subsystem: api
tags: [EventEmitter, domain-events, pr-snapshot, ratchet, github, workspace-activity]

# Dependency graph
requires:
  - phase: 12-domain-event-emission
    plan: 01
    provides: "EventEmitter pattern for domain event emission (established in state machines)"
provides:
  - "PRSnapshotService extends EventEmitter, emits PR_SNAPSHOT_UPDATED after applySnapshot"
  - "RatchetService extends EventEmitter, emits RATCHET_STATE_CHANGED on state transitions"
  - "EVNT-05 confirmed: WorkspaceActivityService already emits workspace_active/workspace_idle"
  - "Typed event constants and payload interfaces exported from domain barrels"
affects: [13-event-collector, snapshot-store-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [EventEmitter-based domain event emission after mutations]

key-files:
  modified:
    - src/backend/domains/github/pr-snapshot.service.ts
    - src/backend/domains/github/pr-snapshot.service.test.ts
    - src/backend/domains/github/index.ts
    - src/backend/domains/ratchet/ratchet.service.ts
    - src/backend/domains/ratchet/ratchet.service.test.ts
    - src/backend/domains/ratchet/index.ts

key-decisions:
  - "PR snapshot always emits (no old vs new comparison) -- Phase 13 coalescer handles dedup"
  - "Ratchet emits only when state actually changes (fromState !== toState) -- both disabled early return and main path"
  - "No emit on error/shutdown paths -- these are not state changes"
  - "Removed explicit constructor() { super(); } per biome noUselessConstructor lint rule"

patterns-established:
  - "Always-emit pattern: PR snapshot emits every time, dedup deferred to consumer (coalescer)"
  - "Conditional-emit pattern: Ratchet emits only on actual state change (guard check before emit)"

# Metrics
duration: 9min
completed: 2026-02-11
---

# Phase 12 Plan 02: PR Snapshot and Ratchet Event Emission Summary

**EventEmitter-based PR snapshot and ratchet state change events with 10 emission/non-emission tests, EVNT-05 verified**

## Performance

- **Duration:** 9 min
- **Started:** 2026-02-11T16:20:37Z
- **Completed:** 2026-02-11T16:29:58Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- PRSnapshotService extends EventEmitter and emits PR_SNAPSHOT_UPDATED after every successful applySnapshot() with workspaceId, prNumber, prState, prCiStatus, prReviewState payload
- RatchetService extends EventEmitter and emits RATCHET_STATE_CHANGED on state transitions in both the disabled early return path (IDLE settling) and main processWorkspace path, only when state actually changes
- 10 new tests: 5 for PR snapshot (applySnapshot, refreshWorkspace success, workspace not found, no prUrl, attachAndRefreshPR) and 5 for ratchet (disabled state change, disabled already IDLE, main path change, main path unchanged, error path)
- EVNT-05 confirmed: WorkspaceActivityService already extends EventEmitter and emits workspace_active/workspace_idle events
- Event constants and payload types exported from domain barrels for downstream consumers

## Task Commits

Each task was committed atomically:

1. **Task 1: Add event emission to PR snapshot and ratchet services** - `e5b91af` (feat)
2. **Task 2: Add event emission tests for PR snapshot and ratchet services** - `1c90aa0` (test)
3. **Refactor: Remove useless constructors flagged by biome** - `3d19f46` (refactor)

## Files Created/Modified
- `src/backend/domains/github/pr-snapshot.service.ts` - Extended EventEmitter, added PR_SNAPSHOT_UPDATED constant, PRSnapshotUpdatedEvent type, emit call in applySnapshot()
- `src/backend/domains/github/index.ts` - Barrel exports for PR_SNAPSHOT_UPDATED and PRSnapshotUpdatedEvent
- `src/backend/domains/ratchet/ratchet.service.ts` - Extended EventEmitter, added RATCHET_STATE_CHANGED constant, RatchetStateChangedEvent type, emit calls in processWorkspace() disabled path and main path
- `src/backend/domains/ratchet/index.ts` - Barrel exports for RATCHET_STATE_CHANGED and RatchetStateChangedEvent
- `src/backend/domains/github/pr-snapshot.service.test.ts` - 5 event emission tests
- `src/backend/domains/ratchet/ratchet.service.test.ts` - 5 event emission tests

## Decisions Made
- PR snapshot always emits (no old vs new comparison) -- Phase 13 coalescer handles dedup, per research recommendation
- Ratchet emits only when state actually changes (guard check `previousState !== finalState`) -- avoids noise from unchanged polls
- No emit on error/shutdown paths -- these preserve current state without mutation
- Removed explicit `constructor() { super(); }` from all 4 EventEmitter subclasses (including plan 01's workspace and run-script) per biome's noUselessConstructor lint rule -- implicit constructor already calls super() when extending a class

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 1 merged with plan 01 uncommitted test files during commit**
- **Found during:** Task 1 (commit phase)
- **Issue:** Plan 01 had staged but uncommitted test files (workspace and run-script state machine tests) that were picked up by lint-staged during task 1 commit, causing them to be committed together with task 1 changes under the plan 01 commit message
- **Fix:** Proceeded with execution; code changes are correct and committed, just under a different commit message than intended
- **Files affected:** Commit `e5b91af` contains both plan 01 test files and plan 02 task 1 service changes
- **Verification:** All tests pass, typecheck clean

**2. [Rule 1 - Bug] Removed useless constructors flagged by biome**
- **Found during:** Task 2 verification
- **Issue:** Biome flagged `constructor() { super(); }` as unnecessary in 4 EventEmitter subclasses (plan 01 + plan 02 services)
- **Fix:** Removed explicit constructors since implicit constructor already calls super() when extending a class
- **Files modified:** pr-snapshot.service.ts, ratchet.service.ts, run-script-state-machine.service.ts, state-machine.service.ts
- **Committed in:** `3d19f46`

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
- Lint-staged stash/restore cycle during failed first commit caused file state confusion; resolved by re-applying test changes after commit stabilized

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 5 event points (EVNT-01 through EVNT-05) now emit typed events:
  - EVNT-01: WORKSPACE_STATE_CHANGED (from plan 01)
  - EVNT-02: PR_SNAPSHOT_UPDATED (this plan)
  - EVNT-03: RATCHET_STATE_CHANGED (this plan)
  - EVNT-04: RUN_SCRIPT_STATUS_CHANGED (from plan 01)
  - EVNT-05: workspace_active/workspace_idle (pre-existing in WorkspaceActivityService)
- Event constants and payload types available from domain barrels for type-safe consumption
- Ready for Phase 13 (Event Collector) to wire up listeners and feed the snapshot store

## Self-Check: PASSED

All 6 modified files verified present. All 3 task commits (e5b91af, 1c90aa0, 3d19f46) verified in git log.

---
*Phase: 12-domain-event-emission*
*Completed: 2026-02-11*
