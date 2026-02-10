---
phase: 06-terminal-domain-consolidation
plan: 01
subsystem: backend
tags: [pty, node-pty, terminal, domain-consolidation, srp]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: domain scaffolding pattern, directory structure
provides:
  - Terminal domain at src/backend/domains/terminal/ with TerminalService class
  - Re-export shim at src/backend/services/terminal.service.ts for backward compat
  - Domain barrel with full public API (singleton + class + 5 types)
  - Co-located unit tests covering all 15+ public API methods (TERM-03)
  - Barrel export smoke test
affects: [08-orchestration-layer, 09-import-rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [move-and-shim for terminal domain, instance-based Maps verified]

key-files:
  created:
    - src/backend/domains/terminal/terminal.service.ts
    - src/backend/domains/terminal/terminal.service.test.ts
    - src/backend/domains/terminal/terminal-domain-exports.test.ts
  modified:
    - src/backend/domains/terminal/index.ts
    - src/backend/services/terminal.service.ts

key-decisions:
  - "Logger import updated from relative to absolute @/ path for cross-domain import"
  - "TerminalService class exported for test isolation via fresh instances"
  - "Shim uses direct module path (not barrel) to avoid circular dep risks"

patterns-established:
  - "Terminal domain follows same move-and-shim pattern as session, workspace, github domains"

# Metrics
duration: 4min
completed: 2026-02-10
---

# Phase 6 Plan 1: Terminal Domain Consolidation Summary

**Terminal PTY service moved to domain with shim, barrel, and 34 co-located unit tests covering full public API**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-10T17:05:36Z
- **Completed:** 2026-02-10T17:09:17Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Terminal domain owns PTY management, output buffering, and monitoring (TERM-01)
- Verified all 4 Maps are private instance fields with no module-level mutable state (TERM-02)
- 34 co-located unit tests covering all public API methods (TERM-03)
- Re-export shim preserves backward compatibility for all existing consumers
- Full test suite passes (1775 tests, 0 regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1: Move terminal.service.ts to domain, create shim, populate barrel** - `5d61d79` (feat)
2. **Task 2: Create domain unit tests and barrel smoke test (TERM-03)** - `c3f571d` (test)

## Files Created/Modified
- `src/backend/domains/terminal/terminal.service.ts` - TerminalService class with exported class + singleton (moved from services/)
- `src/backend/domains/terminal/index.ts` - Domain barrel with selective named exports (7 exports)
- `src/backend/services/terminal.service.ts` - Re-export shim (@deprecated, direct module path)
- `src/backend/domains/terminal/terminal.service.test.ts` - 33 unit tests covering all public API methods
- `src/backend/domains/terminal/terminal-domain-exports.test.ts` - Barrel export smoke test (1 test)

## Decisions Made
- Logger import updated from relative `./logger.service` to absolute `@/backend/services/logger.service` for cross-domain import pattern
- TerminalService class exported (was private) for test isolation via `new TerminalService()` in tests
- Shim imports from direct module path (`@/backend/domains/terminal/terminal.service`) not barrel to avoid circular dep risks

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed unused MockInstance import**
- **Found during:** Task 2 (unit tests)
- **Issue:** Biome flagged unused `MockInstance` type import from vitest
- **Fix:** Removed the unused import
- **Files modified:** src/backend/domains/terminal/terminal.service.test.ts
- **Verification:** `pnpm check:fix` passes cleanly
- **Committed in:** c3f571d (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Trivial lint fix. No scope change.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Terminal domain fully consolidated with TERM-01, TERM-02, TERM-03 satisfied
- Ready for Phase 7 (Run Script Domain Consolidation) or Phase 8 (Orchestration Layer)
- All 7 existing consumers continue to work via shim at old path

## Self-Check: PASSED

All 5 files verified present. Both commit hashes (5d61d79, c3f571d) confirmed in git log.

---
*Phase: 06-terminal-domain-consolidation*
*Completed: 2026-02-10*
