---
phase: 09-appcontext-import-rewiring
plan: 01
subsystem: api
tags: [imports, barrels, bridges, dependency-injection, refactor]

# Dependency graph
requires:
  - phase: 08-orchestration-layer
    provides: bridge injection pattern, domain-bridges orchestrator
provides:
  - app-context.ts using domain barrel imports instead of shim paths
  - reconciliation.service.ts using bridge injection for workspace markFailed
  - session-publisher.ts using relative intra-domain imports
  - session-domain.service.test.ts using source-level mock paths
affects: [09-02, 09-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [bridge injection for reconciliation cross-domain dependency]

key-files:
  modified:
    - src/backend/app-context.ts
    - src/backend/domains/ratchet/bridges.ts
    - src/backend/domains/ratchet/reconciliation.service.ts
    - src/backend/domains/ratchet/index.ts
    - src/backend/orchestration/domain-bridges.orchestrator.ts
    - src/backend/domains/session/store/session-publisher.ts
    - src/backend/domains/session/session-domain.service.test.ts

key-decisions:
  - "Test mocks target source module paths, not barrel paths, because Vitest module mocking is path-specific"
  - "SessionManager mock kept on @/backend/claude shim path (matches session-hydrator.ts internal import)"
  - "chatConnectionService mock targets chat-connection.service module directly (matches session-publisher.ts relative import)"
  - "RatchetWorkspaceBridge only needs markFailed (reconciliation doesn't use markReady)"
  - "async wrapper in bridge wiring to convert Promise<Workspace> to Promise<void>"

patterns-established:
  - "Test mock paths must match the actual import paths used by the code under test"
  - "Bridge interface return types can be narrower than the underlying implementation"

# Metrics
duration: 10min
completed: 2026-02-10
---

# Phase 09 Plan 01: App-Context & Foundation Import Rewiring Summary

**app-context.ts rewired to domain barrels, reconciliation.service.ts bridge-injected for workspace markFailed, session domain internal imports fixed**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-10T20:37:55Z
- **Completed:** 2026-02-10T20:48:25Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Rewired all 14 shim imports in app-context.ts to use 6 domain barrel imports plus 7 infrastructure service imports
- Added RatchetWorkspaceBridge interface and bridge injection to reconciliation.service.ts, eliminating cross-domain workspace-state-machine import
- Fixed session-publisher.ts to use relative intra-domain imports instead of shim paths
- Updated session-domain.service.test.ts mocks to target correct source module paths

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewire app-context.ts and fix domain-internal shim imports** - `9935b56d` (feat)
2. **Task 2: Add workspace bridge to reconciliation.service.ts** - `ae0884d1` (feat)

## Files Created/Modified
- `src/backend/app-context.ts` - DI wiring using domain barrels instead of shim paths
- `src/backend/domains/session/store/session-publisher.ts` - Relative intra-domain imports for chat-connection and session-file-logger
- `src/backend/domains/session/session-domain.service.test.ts` - Source-level mock paths for chatConnectionService and SessionManager
- `src/backend/domains/ratchet/bridges.ts` - New RatchetWorkspaceBridge interface
- `src/backend/domains/ratchet/index.ts` - Export RatchetWorkspaceBridge type
- `src/backend/domains/ratchet/reconciliation.service.ts` - Bridge injection replacing direct workspace-state-machine import
- `src/backend/orchestration/domain-bridges.orchestrator.ts` - Reconciliation workspace bridge wiring

## Decisions Made
- Test mocks must target the exact import paths used by internal code (Vitest module mocking is path-specific, not identity-based)
- SessionManager mock kept on `@/backend/claude` shim path because session-hydrator.ts imports from there
- chatConnectionService mock targets `@/backend/domains/session/chat/chat-connection.service` because session-publisher.ts uses relative import resolving there
- RatchetWorkspaceBridge only exposes markFailed (reconciliation doesn't use markReady -- that's handled by initializeWorkspaceWorktree orchestrator)
- async wrapper needed in bridge wiring to convert workspaceStateMachine.markFailed return type from Promise<Workspace> to Promise<void>

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test mock paths must match internal import paths, not barrel paths**
- **Found during:** Task 1 (session-domain.service.test.ts update)
- **Issue:** Plan specified importing SessionManager and chatConnectionService from `@/backend/domains/session` barrel and mocking that barrel. But Vitest module mocking is path-specific -- the barrel mock doesn't intercept internal imports from `@/backend/claude` (used by session-hydrator.ts) or `../chat/chat-connection.service` (used by session-publisher.ts).
- **Fix:** Import SessionManager from `@/backend/claude` (matching hydrator's import) and chatConnectionService from `@/backend/domains/session/chat/chat-connection.service` (matching publisher's resolved import). Mock both at their source module paths.
- **Files modified:** src/backend/domains/session/session-domain.service.test.ts
- **Verification:** All 24 session-domain tests pass
- **Committed in:** 9935b56d (Task 1 commit)

**2. [Rule 1 - Bug] Bridge wiring return type mismatch**
- **Found during:** Task 2 (domain-bridges.orchestrator.ts update)
- **Issue:** workspaceStateMachine.markFailed() returns Promise<Workspace>, but RatchetWorkspaceBridge.markFailed expects Promise<void>. Direct delegation causes TS2322.
- **Fix:** Wrapped in async function that awaits and discards return value.
- **Files modified:** src/backend/orchestration/domain-bridges.orchestrator.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** ae0884d1 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
- Biome check:fix auto-modified import paths in unrelated files (conversation-analyzer.ts, conversation-rename.interceptor.ts, etc.), creating circular dependency chains when staged. Resolved by reverting unrelated biome changes and only staging task-specific files.
- Lint-staged backup/restore mechanism can revert staged changes when a parallel process commits to the same branch. Resolved by ensuring clean unstaged state before committing.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Foundation shim dependencies eliminated for app-context.ts, reconciliation.service.ts, session-publisher.ts, and session-domain.service.test.ts
- Plan 02 (consumer rewiring) and Plan 03 (shim deletion) can proceed
- All type checks pass, dependency-cruiser validates clean, all tests pass

## Self-Check: PASSED

All 7 key files verified present. Both task commits (9935b56d, ae0884d1) verified in git log.

---
*Phase: 09-appcontext-import-rewiring*
*Completed: 2026-02-10*
