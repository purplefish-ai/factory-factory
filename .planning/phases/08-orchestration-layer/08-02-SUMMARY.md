---
phase: 08-orchestration-layer
plan: 02
subsystem: api
tags: [bridge-pattern, dependency-injection, ratchet, ci-monitor, ci-fixer]

# Dependency graph
requires:
  - phase: 05-ratchet-domain
    provides: ratchet domain services consolidated into src/backend/domains/ratchet/
  - phase: 08-orchestration-layer plan 01
    provides: orchestration layer pattern with bridge interfaces
provides:
  - Ratchet domain with zero cross-domain imports to session or github
  - Bridge interfaces (RatchetSessionBridge, RatchetGitHubBridge) for orchestration wiring
  - All ratchet services use configure() pattern for dependency injection
affects: [08-orchestration-layer plan 03, 09-appcontext-import-rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [bridge-interface-injection, configure-pattern, fail-fast-getter]

key-files:
  created:
    - src/backend/domains/ratchet/bridges.ts
  modified:
    - src/backend/domains/ratchet/ratchet.service.ts
    - src/backend/domains/ratchet/fixer-session.service.ts
    - src/backend/domains/ratchet/ci-fixer.service.ts
    - src/backend/domains/ratchet/ci-monitor.service.ts
    - src/backend/domains/ratchet/ci-fixer.service.test.ts
    - src/backend/domains/ratchet/index.ts

key-decisions:
  - "Bridge interfaces defined in bridges.ts with lightweight types (no dependency on github/session domain types)"
  - "configure() method on each service accepts bridge objects; private getter throws if not configured (fail-fast)"
  - "Test updated from vi.mock module mocking to bridge injection via configure()"

patterns-established:
  - "Bridge injection: services declare bridge interfaces for cross-domain capabilities, configured at startup"
  - "Fail-fast getter: private get session()/github() throws descriptive error if configure() not called"

# Metrics
duration: 2min
completed: 2026-02-10
---

# Phase 8 Plan 02: Ratchet Domain Bridge Injection Summary

**All 5 ratchet domain services (ratchet, fixer-session, ci-fixer, ci-monitor, reconciliation) have zero cross-domain imports, using typed bridge interfaces injected via configure() pattern**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-10T19:10:14Z
- **Completed:** 2026-02-10T19:12:32Z
- **Tasks:** 2 (Task 1 was pre-committed)
- **Files modified:** 7

## Accomplishments
- Removed all imports from `@/backend/services/session.service`, `@/backend/services/github-cli.service`, and `@/backend/services/session-domain.service` from the ratchet domain
- All 4 ratchet services (ratchet, fixer-session, ci-fixer, ci-monitor) use bridge interfaces with configure() injection
- Bridge types exported from ratchet barrel for orchestration layer wiring
- Test updated to use bridge injection instead of module mocking

## Task Commits

Each task was committed atomically:

1. **Task 1: Add bridge interfaces, refactor ratchet.service and fixer-session.service** - `95a1a14c` (feat)
2. **Task 2: Refactor ci-fixer.service and ci-monitor.service to use bridges** - `91ca870c` (refactor)

## Files Created/Modified
- `src/backend/domains/ratchet/bridges.ts` - Bridge interfaces (RatchetSessionBridge, RatchetGitHubBridge) with lightweight types
- `src/backend/domains/ratchet/ratchet.service.ts` - Uses session + github bridges via configure()
- `src/backend/domains/ratchet/fixer-session.service.ts` - Uses session bridge via configure()
- `src/backend/domains/ratchet/ci-fixer.service.ts` - Uses session bridge via configure()
- `src/backend/domains/ratchet/ci-monitor.service.ts` - Uses session + github bridges via configure()
- `src/backend/domains/ratchet/ci-fixer.service.test.ts` - Updated to bridge injection
- `src/backend/domains/ratchet/index.ts` - Exports bridge types for orchestration layer

## Decisions Made
- Bridge interfaces defined with lightweight types (no dependency on github/session domain types) to keep the ratchet domain fully self-contained
- configure() method on each service accepts bridge objects; private getter throws if not configured (fail-fast pattern)
- ci-fixer test updated from vi.mock module mocking to bridge injection via configure() -- other test files (ratchet.service.test.ts, fixer-session.service.test.ts) were already updated in Task 1

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All ratchet domain services are ready for orchestration layer wiring (Plan 03)
- Bridge types are exported from the ratchet barrel for the orchestration layer to implement
- reconciliation.service.ts already had no session/github cross-domain imports (uses orchestration layer)

## Self-Check: PASSED

All files verified present. All commits verified in git history.

---
*Phase: 08-orchestration-layer*
*Completed: 2026-02-10*
