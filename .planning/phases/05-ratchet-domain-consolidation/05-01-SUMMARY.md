---
phase: 05-ratchet-domain-consolidation
plan: 01
subsystem: backend
tags: [ratchet, domain-consolidation, move-and-shim, ci-fixer, ci-monitor, fixer-session]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: Domain scaffolding with src/backend/domains/ratchet/ directory and barrel
provides:
  - fixer-session.service.ts in ratchet domain (241 LOC)
  - ci-fixer.service.ts in ratchet domain (180 LOC)
  - ci-monitor.service.ts in ratchet domain (407 LOC)
  - Co-located tests for fixer-session and ci-fixer (12 tests)
  - Re-export shims at old services/ paths
  - Intra-domain relative imports (ci-fixer -> fixer-session, ci-monitor -> ci-fixer)
affects: [05-02 ratchet.service move, 05-03 barrel + smoke test, 09 import rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [move-and-shim for ratchet domain, intra-domain relative imports]

key-files:
  created:
    - src/backend/domains/ratchet/fixer-session.service.ts
    - src/backend/domains/ratchet/fixer-session.service.test.ts
    - src/backend/domains/ratchet/ci-fixer.service.ts
    - src/backend/domains/ratchet/ci-fixer.service.test.ts
    - src/backend/domains/ratchet/ci-monitor.service.ts
  modified:
    - src/backend/services/fixer-session.service.ts
    - src/backend/services/ci-fixer.service.ts
    - src/backend/services/ci-monitor.service.ts
    - knip.json

key-decisions:
  - "Knip ignore for domain service files -- ci-monitor has no external consumers"

patterns-established:
  - "Intra-domain relative imports: ci-fixer -> ./fixer-session.service, ci-monitor -> ./ci-fixer.service"

# Metrics
duration: 5min
completed: 2026-02-10
---

# Phase 05 Plan 01: Move Leaf Ratchet Services Summary

**Three internal ratchet services (fixer-session, ci-fixer, ci-monitor) moved to src/backend/domains/ratchet/ with intra-domain relative imports and re-export shims at old paths**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-10T16:51:44Z
- **Completed:** 2026-02-10T16:56:49Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Moved fixer-session.service.ts (241 LOC) and ci-fixer.service.ts (180 LOC) to ratchet domain with co-located tests
- Moved ci-monitor.service.ts (407 LOC) to ratchet domain (no test file exists for this service)
- Established intra-domain dependency chain: ci-monitor -> ci-fixer -> fixer-session via relative imports
- All 12 tests pass at new locations; pnpm typecheck, dep-cruise, knip all pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Move fixer-session and ci-fixer to ratchet domain** - `85f94564` (feat)
2. **Task 2: Move ci-monitor to ratchet domain** - `81d44fe9` (feat)

**Plan metadata:** (pending) (docs: complete plan)

## Files Created/Modified
- `src/backend/domains/ratchet/fixer-session.service.ts` - Fixer session acquisition and dispatch logic (moved from services/)
- `src/backend/domains/ratchet/fixer-session.service.test.ts` - 6 tests for fixer session service (moved from services/)
- `src/backend/domains/ratchet/ci-fixer.service.ts` - CI failure fix session management (moved from services/)
- `src/backend/domains/ratchet/ci-fixer.service.test.ts` - 6 tests for CI fixer service (moved from services/)
- `src/backend/domains/ratchet/ci-monitor.service.ts` - CI status polling and notification loop (moved from services/)
- `src/backend/services/fixer-session.service.ts` - Re-export shim for backward compatibility
- `src/backend/services/ci-fixer.service.ts` - Re-export shim for backward compatibility
- `src/backend/services/ci-monitor.service.ts` - Re-export shim for backward compatibility
- `knip.json` - Added domain service file ignore pattern

## Decisions Made
- **Knip ignore for domain service files:** ci-monitor.service.ts has no external consumers (it self-starts). The original file was already effectively unused but ignored by the services/ glob. Added `src/backend/domains/**/*.service.ts` to knip ignore to cover domain service files that may not be imported through barrels.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added knip ignore pattern for domain service files**
- **Found during:** Task 2 (Move ci-monitor to ratchet domain)
- **Issue:** Knip flagged src/backend/domains/ratchet/ci-monitor.service.ts as unused because it has no external consumers. The original file in services/ was covered by the existing `src/backend/services/*.service.ts` ignore glob.
- **Fix:** Added `src/backend/domains/**/*.service.ts` to knip.json ignore array
- **Files modified:** knip.json
- **Verification:** pnpm knip passes with no unused file findings
- **Committed in:** 81d44fe9 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Knip config fix necessary for pre-commit hook to pass. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Three leaf/internal ratchet services established in domain directory
- Ready for Plan 02: Move ratchet.service.ts (the orchestrator) which imports fixer-session via intra-domain relative path
- Ready for Plan 03: Barrel exports and smoke test

## Self-Check: PASSED

All 8 expected files found. Both task commits (85f94564, 81d44fe9) verified in git log.

---
*Phase: 05-ratchet-domain-consolidation*
*Completed: 2026-02-10*
