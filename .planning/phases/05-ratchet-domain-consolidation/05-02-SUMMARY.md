---
phase: 05-ratchet-domain-consolidation
plan: 02
subsystem: backend
tags: [ratchet, domain-consolidation, move-and-shim, reconciliation, polling-loop]

# Dependency graph
requires:
  - phase: 05-01
    provides: Leaf ratchet services (fixer-session, ci-fixer, ci-monitor) in domain directory
provides:
  - ratchet.service.ts in ratchet domain (1010 LOC, 17 tests)
  - reconciliation.service.ts in ratchet domain (186 LOC, 12 tests)
  - Intra-domain relative import ratchet.service -> ./fixer-session.service
  - Re-export shims at old services/ paths for ratchet and reconciliation
  - All 5 ratchet domain source files now in place
affects: [05-03 barrel + smoke test, 09 import rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [cross-domain import via services/ shim to avoid dep-cruiser violation]

key-files:
  created:
    - src/backend/domains/ratchet/ratchet.service.ts
    - src/backend/domains/ratchet/ratchet.service.test.ts
    - src/backend/domains/ratchet/reconciliation.service.ts
    - src/backend/domains/ratchet/reconciliation.service.test.ts
  modified:
    - src/backend/services/ratchet.service.ts
    - src/backend/services/reconciliation.service.ts

key-decisions:
  - "Cross-domain session-domain import routed through services/ shim to satisfy dep-cruiser no-cross-domain-imports rule"

patterns-established:
  - "Cross-domain imports between domain directories must go through services/ shims, not direct @/backend/domains/X/ paths"

# Metrics
duration: 7min
completed: 2026-02-10
---

# Phase 05 Plan 02: Move Core Ratchet Services Summary

**Ratchet polling loop (1010 LOC) and reconciliation service (186 LOC) moved to src/backend/domains/ratchet/ with cross-domain imports routed through services/ shims**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-10T16:59:14Z
- **Completed:** 2026-02-10T17:06:14Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Moved ratchet.service.ts (1010 LOC, core polling loop and dispatch engine) to ratchet domain with 17 co-located tests
- Moved reconciliation.service.ts (186 LOC, workspace/session orphan cleanup) to ratchet domain with 12 co-located tests
- All 5 ratchet domain source files now in place: fixer-session, ci-fixer, ci-monitor, ratchet, reconciliation
- Intra-domain relative import chain maintained: ratchet -> ./fixer-session.service

## Task Commits

Each task was committed atomically:

1. **Task 1: Move ratchet.service.ts to ratchet domain** - `d9c4e1a7` (feat)
2. **Task 2: Move reconciliation.service.ts to ratchet domain** - `cd315635` (feat)

**Plan metadata:** `6b04af89` (docs: complete plan)

## Files Created/Modified
- `src/backend/domains/ratchet/ratchet.service.ts` - Core ratchet polling loop, PR state detection, and fixer dispatch engine (moved from services/)
- `src/backend/domains/ratchet/ratchet.service.test.ts` - 17 tests for ratchet service (moved from services/)
- `src/backend/domains/ratchet/reconciliation.service.ts` - Workspace worktree reconciliation and orphan cleanup (moved from services/)
- `src/backend/domains/ratchet/reconciliation.service.test.ts` - 12 tests for reconciliation service (moved from services/)
- `src/backend/services/ratchet.service.ts` - Re-export shim for backward compatibility (ratchetService, RatchetAction, RatchetCheckResult, WorkspaceRatchetResult)
- `src/backend/services/reconciliation.service.ts` - Re-export shim for backward compatibility (reconciliationService)

## Decisions Made
- **Cross-domain session-domain import routed through services/ shim:** The original ratchet.service.ts imported `sessionDomainService` directly from `@/backend/domains/session/session-domain.service`. After moving into the ratchet domain, this became a cross-domain import that violated the dependency-cruiser `no-cross-domain-imports` rule. Routed through the existing `@/backend/services/session-domain.service` shim instead.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Cross-domain import violation for sessionDomainService**
- **Found during:** Task 1 (Move ratchet.service.ts to ratchet domain)
- **Issue:** dependency-cruiser's `no-cross-domain-imports` rule blocked the commit because `src/backend/domains/ratchet/ratchet.service.ts` was importing directly from `src/backend/domains/session/session-domain.service.ts`
- **Fix:** Changed import path from `@/backend/domains/session/session-domain.service` to `@/backend/services/session-domain.service` (existing shim). Updated corresponding vi.mock path in test file.
- **Files modified:** src/backend/domains/ratchet/ratchet.service.ts, src/backend/domains/ratchet/ratchet.service.test.ts
- **Verification:** pnpm typecheck passes, dep-cruiser reports 0 violations, 17 tests pass
- **Committed in:** d9c4e1a7 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Cross-domain import routing necessary for dep-cruiser compliance. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 5 ratchet domain source files are in place (fixer-session, ci-fixer, ci-monitor, ratchet, reconciliation)
- Ready for Plan 03: Populate barrel exports in index.ts and add smoke test
- 41 total tests pass across 4 test files in the ratchet domain

## Self-Check: PASSED

All 6 expected files found. Both task commits (d9c4e1a7, cd315635) verified in git log.

---
*Phase: 05-ratchet-domain-consolidation*
*Completed: 2026-02-10*
