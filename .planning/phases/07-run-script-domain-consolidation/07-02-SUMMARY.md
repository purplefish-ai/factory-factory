---
phase: 07-run-script-domain-consolidation
plan: 02
subsystem: run-script
tags: [domain-consolidation, barrel-exports, smoke-test, startup-script, backward-compatibility]

# Dependency graph
requires:
  - phase: 07-run-script-domain-consolidation
    plan: 01
    provides: run-script-state-machine.service.ts and run-script.service.ts in domains/run-script/
provides:
  - startup-script.service.ts in domains/run-script/ with all exports preserved
  - Re-export shim at old services/ path for backward compatibility
  - Domain barrel at index.ts with full public API (5 runtime values + 2 types)
  - Barrel smoke test confirming all runtime exports are defined
  - RS-01 complete: all run script operations flow through domains/run-script/
affects: [08-orchestration-layer, 09-import-rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [domain barrel with selective named exports, barrel smoke test pattern]

key-files:
  created:
    - src/backend/domains/run-script/startup-script.service.ts
    - src/backend/domains/run-script/run-script-domain-exports.test.ts
  modified:
    - src/backend/services/startup-script.service.ts
    - src/backend/domains/run-script/index.ts

key-decisions:
  - "Cross-domain workspace-state-machine import uses @/backend/services/ shim path (no cross-domain violation)"
  - "Barrel uses selective named exports per established convention (no export *)"

patterns-established:
  - "Startup script cross-domain deps use absolute @/backend/services/ shim paths"
  - "Domain barrel consolidates full public API from all constituent services"

# Metrics
duration: 3min
completed: 2026-02-10
---

# Phase 7 Plan 02: Run Script Barrel and Startup Script Summary

**Startup-script.service.ts moved to domain, barrel populated with full public API (5 runtime + 2 type exports from 3 services), smoke test verifying all exports**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-10T17:55:04Z
- **Completed:** 2026-02-10T17:58:30Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Moved startup-script.service.ts (369 LOC) to domains/run-script/ with all cross-domain imports using absolute @/backend/ paths
- Cross-domain import to workspace-state-machine uses @/backend/services/ shim path (avoids cross-domain violation)
- Re-export shim at old services/ path maintains backward compatibility for 3 consumers
- Domain barrel exports full public API: RunScriptService, runScriptService, RunScriptStateMachineError, runScriptStateMachine, TransitionOptions, startupScriptService, StartupScriptResult
- Smoke test verifies all 5 runtime exports are defined with correct types
- RS-01 complete: all 3 run script services consolidated into src/backend/domains/run-script/

## Task Commits

Each task was committed atomically:

1. **Task 1: Move startup-script.service.ts to domain** - `88b184f6` (feat)
2. **Task 2: Populate run-script domain barrel and create smoke test** - `e466cdc0` (feat)

## Files Created/Modified
- `src/backend/domains/run-script/startup-script.service.ts` - Startup script execution service moved from services/ with absolute cross-domain imports
- `src/backend/domains/run-script/run-script-domain-exports.test.ts` - Barrel smoke test verifying all 5 runtime exports
- `src/backend/domains/run-script/index.ts` - Domain barrel with full public API (3 module re-exports)
- `src/backend/services/startup-script.service.ts` - Re-export shim for backward compatibility (deprecated)

## Decisions Made
- **Cross-domain workspace-state-machine via shim path:** startup-script.service.ts imports workspaceStateMachine from `@/backend/services/workspace-state-machine.service` (the shim) rather than directly from `@/backend/domains/workspace/` to avoid a cross-domain import violation.
- **Selective named exports in barrel:** Followed established convention of explicit named re-exports (not `export *`) to control the public API surface.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Run-script domain consolidation (Phase 7) is fully complete
- All 3 services in src/backend/domains/run-script/: run-script-state-machine.service, run-script.service, startup-script.service
- Domain barrel provides single import point for all consumers
- Re-export shims at old services/ paths ensure backward compatibility
- Ready for Phase 8 (Orchestration Layer) which depends on phases 2-7

---
## Self-Check: PASSED

All 4 files verified present. Both task commits (88b184f6, e466cdc0) verified in git log.

---
*Phase: 07-run-script-domain-consolidation*
*Completed: 2026-02-10*
