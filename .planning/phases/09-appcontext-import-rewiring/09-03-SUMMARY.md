---
phase: 09-appcontext-import-rewiring
plan: 03
subsystem: infra
tags: [srp, import-rewiring, shim-deletion, dependency-graph, cleanup]

# Dependency graph
requires:
  - phase: 09-appcontext-import-rewiring (plans 01-02)
    provides: All consumers rewired from shim imports to domain barrel imports
provides:
  - Clean services/ directory with only infrastructure services
  - No deprecated shim files in src/backend/services/
  - No src/backend/claude/ directory
  - No src/backend/services/session-store/ directory
  - Extracted getClaudeProjectPath utility in src/backend/lib/claude-paths.ts
affects: [phase-10-validation]

# Tech tracking
tech-stack:
  added: []
  patterns: [shared-utility-extraction, bridge-pattern-for-cross-domain]

key-files:
  created:
    - src/backend/lib/claude-paths.ts
  modified:
    - src/backend/services/index.ts
    - src/backend/services/cli-health.service.ts
    - src/backend/services/scheduler.service.ts
    - src/backend/services/scheduler.service.test.ts
    - src/backend/domains/ratchet/fixer-session.service.ts
    - src/backend/domains/ratchet/reconciliation.service.test.ts
    - src/backend/domains/workspace/lifecycle/creation.service.ts
    - src/backend/domains/session/store/session-hydrator.ts
    - src/backend/domains/session/session-domain.service.test.ts
    - src/backend/domains/session/chat/chat-connection.service.ts
    - src/backend/domains/session/chat/chat-event-forwarder.service.ts
    - src/backend/domains/session/chat/chat-event-forwarder.service.test.ts
    - knip.json

key-decisions:
  - "Extract getClaudeProjectPath to src/backend/lib/ to avoid cross-domain imports"
  - "Route test mock paths to match updated source import paths"
  - "Configure workspace bridge in reconciliation test for markFailed"
  - "Remove stale knip ignore entries for deleted directories"

patterns-established:
  - "Shared utility extraction: Pure functions used by multiple domains live in src/backend/lib/"
  - "Infrastructure-only barrel: services/index.ts exports only cross-cutting infrastructure"

# Metrics
duration: 9min
completed: 2026-02-10
---

# Phase 9 Plan 3: Shim Deletion & Infrastructure Barrel Cleanup Summary

**Deleted 61 deprecated shim files (29 services, 16 claude, 14 session-store, 2 shim tests) and rewired services/index.ts to infrastructure-only exports with zero dependency-cruiser violations**

## Performance

- **Duration:** 9 min
- **Started:** 2026-02-10T20:55:34Z
- **Completed:** 2026-02-10T21:04:49Z
- **Tasks:** 2
- **Files modified:** 81

## Accomplishments
- Deleted all 61 deprecated shim files across services/, claude/, and session-store/
- Rewired services/index.ts to export only 9 infrastructure services (cli-health, config, data-backup, logger, notification, port, rate-limiter, scheduler, server-instance)
- Fixed 6 remaining shim consumers in domain files that were missed by Plan 02 (session-file-logger, @/backend/claude paths)
- Extracted getClaudeProjectPath to src/backend/lib/claude-paths.ts to resolve cross-domain dependency-cruiser violations
- Updated test mock paths in scheduler.service.test.ts and reconciliation.service.test.ts
- Cleaned up knip.json by removing stale ignore entries for deleted directories
- All 1609 tests pass, 0 dependency-cruiser violations, lint clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete all shim files and session-store/ and claude/ directories** - `aa9ff2a5` (feat)
2. **Task 2: Update services/index.ts and validate clean dependency graph** - `a35ecab6` (fix)

## Files Created/Modified
- `src/backend/lib/claude-paths.ts` - Shared utility for deriving Claude project paths (avoids cross-domain imports)
- `src/backend/services/index.ts` - Rewritten to export only infrastructure services
- `src/backend/services/cli-health.service.ts` - Updated import from domain barrel
- `src/backend/services/scheduler.service.ts` - Updated imports from domain barrel
- `src/backend/services/scheduler.service.test.ts` - Fixed mock paths for domain imports
- `src/backend/domains/ratchet/fixer-session.service.ts` - Uses getClaudeProjectPath instead of SessionManager
- `src/backend/domains/ratchet/reconciliation.service.test.ts` - Configured workspace bridge for markFailed test
- `src/backend/domains/workspace/lifecycle/creation.service.ts` - Uses getClaudeProjectPath instead of SessionManager
- `src/backend/domains/session/store/session-hydrator.ts` - Direct domain import for SessionManager
- `src/backend/domains/session/session-domain.service.test.ts` - Mock path updated to domain path
- `src/backend/domains/session/chat/chat-connection.service.ts` - Intra-domain import for sessionFileLogger
- `src/backend/domains/session/chat/chat-event-forwarder.service.ts` - Intra-domain import for sessionFileLogger
- `src/backend/domains/session/chat/chat-event-forwarder.service.test.ts` - Mock path updated to domain path
- `knip.json` - Removed stale ignore entries for deleted claude/ and session-store/

## Decisions Made
- **Extract getClaudeProjectPath to src/backend/lib/**: SessionManager.getProjectPath is a pure utility (path.join + string replace) used by both ratchet and workspace domains. Rather than routing through bridges, extracted to shared lib/ layer which any domain can import without violating cross-domain rules.
- **Route test mock paths to match source imports**: Vitest mocks intercept by module path. When source imports changed from shim to domain paths, mock paths had to match exactly.
- **Configure workspace bridge in reconciliation test**: reconciliationService.markFailed now goes through bridge, so test must wire mock bridge that delegates to mockUpdate for assertion compatibility.
- **Remove stale knip ignore entries**: Deleted directories no longer need ignore globs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed 6 remaining shim consumers in domain files**
- **Found during:** Task 1 (shim deletion)
- **Issue:** Plan 02 missed 4 import sites still using shim paths: session-hydrator.ts (from @/backend/claude), session-domain.service.test.ts (mock @/backend/claude), chat-event-forwarder.service.ts (from services/session-file-logger), chat-connection.service.ts (from services/session-file-logger)
- **Fix:** Updated imports to domain-relative paths
- **Files modified:** session-hydrator.ts, session-domain.service.test.ts, chat-event-forwarder.service.ts, chat-event-forwarder.service.test.ts, chat-connection.service.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** aa9ff2a5

**2. [Rule 3 - Blocking] Fixed infrastructure services importing from deleted shims**
- **Found during:** Task 1 (typecheck after deletion)
- **Issue:** cli-health.service.ts imported from ./github-cli.service (deleted shim), scheduler.service.ts imported from ./github-cli.service and ./pr-snapshot.service (deleted shims)
- **Fix:** Updated to import from @/backend/domains/github barrel
- **Files modified:** cli-health.service.ts, scheduler.service.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** aa9ff2a5

**3. [Rule 3 - Blocking] Resolved cross-domain dependency-cruiser violations**
- **Found during:** Task 1 (pre-commit hook)
- **Issue:** fixer-session.service.ts and creation.service.ts imported SessionManager from @/backend/domains/session (cross-domain import flagged by dependency-cruiser)
- **Fix:** Extracted getClaudeProjectPath() utility to src/backend/lib/claude-paths.ts; updated both files to use it
- **Files modified:** src/backend/lib/claude-paths.ts (created), fixer-session.service.ts, creation.service.ts
- **Verification:** dependency-cruiser reports 0 violations
- **Committed in:** aa9ff2a5

**4. [Rule 1 - Bug] Fixed test mock paths in scheduler.service.test.ts**
- **Found during:** Task 2 (test suite run)
- **Issue:** Test mocked ./github-cli.service and ./pr-snapshot.service but source now imports from @/backend/domains/github; mocks had no effect
- **Fix:** Merged both mocks into single vi.mock('@/backend/domains/github', ...)
- **Files modified:** scheduler.service.test.ts
- **Verification:** All 7 scheduler tests pass
- **Committed in:** a35ecab6

**5. [Rule 1 - Bug] Fixed reconciliation.service.test missing bridge configuration**
- **Found during:** Task 2 (test suite run)
- **Issue:** reconciliationService.reconcile() calls this.workspace.markFailed() via bridge, but test never configured bridge, causing "bridges not configured" error
- **Fix:** Added reconciliationService.configure({workspace: {markFailed: ...}}) in beforeEach with mock that delegates to mockUpdate
- **Files modified:** reconciliation.service.test.ts
- **Verification:** All 5 reconciliation tests pass
- **Committed in:** a35ecab6

---

**Total deviations:** 5 auto-fixed (2 bugs, 3 blocking)
**Impact on plan:** All auto-fixes were necessary for correctness. The shim consumer misses from Plan 02 and the cross-domain violation were discovered-at-compile-time issues. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 9 (AppContext & Import Rewiring) is complete
- All domain code lives exclusively in src/backend/domains/
- services/ contains only infrastructure services
- No cross-domain import violations
- Ready for Phase 10 (Validation & Stabilization)

---
*Phase: 09-appcontext-import-rewiring*
*Completed: 2026-02-10*
