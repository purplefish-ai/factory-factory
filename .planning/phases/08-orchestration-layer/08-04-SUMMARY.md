---
phase: 08-orchestration-layer
plan: 04
subsystem: api
tags: [orchestration, bridges, dependency-injection, cross-domain, session, run-script]

# Dependency graph
requires:
  - phase: 08-orchestration-layer (plans 01-03)
    provides: workspace-init orchestrator, workspace-archive orchestrator, ratchet bridge pattern, workspace-query/kanban/pr-review-fixer/pr-snapshot bridge injection
provides:
  - Session domain zero cross-domain imports via SessionWorkspaceBridge and SessionInitPolicyBridge
  - Run-script domain zero cross-domain imports via RunScriptWorkspaceBridge
  - Consolidated configureDomainBridges() orchestrator wiring all 6 domain modules
  - Intra-domain relative imports replacing shim paths in session handler files
affects: [09-appcontext-import-rewiring, 10-validation-stabilization]

# Tech tracking
tech-stack:
  added: []
  patterns: [configure()-with-fail-fast-getter bridge injection, single-entry-point bridge wiring]

key-files:
  created:
    - src/backend/domains/session/bridges.ts
    - src/backend/domains/run-script/bridges.ts
    - src/backend/orchestration/domain-bridges.orchestrator.ts
  modified:
    - src/backend/domains/session/chat/chat-event-forwarder.service.ts
    - src/backend/domains/session/chat/chat-message-handlers.service.ts
    - src/backend/domains/run-script/startup-script.service.ts
    - src/backend/domains/session/index.ts
    - src/backend/domains/run-script/index.ts
    - src/backend/orchestration/index.ts
    - src/backend/server.ts

key-decisions:
  - "Locally-defined types in session bridges.ts avoid Prisma WorkspaceStatus import"
  - "Cast WorkspaceInitPolicyInput at orchestration boundary for type compatibility"
  - "Merged ratchet-bridges.orchestrator into domain-bridges.orchestrator"
  - "Intra-domain relative imports for all 11 session handler files"

patterns-established:
  - "Single configureDomainBridges() entry point for all cross-domain wiring"
  - "Bridge interfaces with lightweight local types to avoid cross-domain type deps"

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 8 Plan 04: Domain Bridge Wiring Summary

**Consolidated all cross-domain bridge wiring into single configureDomainBridges() orchestrator, achieving zero cross-domain imports across all 6 domain modules**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10T19:25:23Z
- **Completed:** 2026-02-10T19:34:07Z
- **Tasks:** 2
- **Files modified:** 24

## Accomplishments
- Session and run-script domains have zero cross-domain imports via typed bridge interfaces
- Single `configureDomainBridges()` orchestrator wires all 6 domains (ratchet, workspace, github, session, run-script, terminal) at startup
- 11 intra-domain session handler files converted from shim paths to relative imports
- dependency-cruiser validates clean across all 740 modules with zero violations

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove cross-domain imports from session and run-script domains** - `408567ce` (feat)
2. **Task 2: Create consolidated domain bridge wiring and verify full cross-domain isolation** - `91d03eea` (feat)

## Files Created/Modified
- `src/backend/domains/session/bridges.ts` - SessionWorkspaceBridge and SessionInitPolicyBridge interfaces
- `src/backend/domains/run-script/bridges.ts` - RunScriptWorkspaceBridge interface
- `src/backend/orchestration/domain-bridges.orchestrator.ts` - Single entry point for all cross-domain bridge wiring
- `src/backend/domains/session/chat/chat-event-forwarder.service.ts` - Uses workspace bridge instead of direct workspaceActivityService import
- `src/backend/domains/session/chat/chat-message-handlers.service.ts` - Uses initPolicy bridge instead of direct getWorkspaceInitPolicy import
- `src/backend/domains/run-script/startup-script.service.ts` - Uses workspace bridge instead of direct workspaceStateMachine import
- `src/backend/domains/session/index.ts` - Exports bridge types
- `src/backend/domains/run-script/index.ts` - Exports bridge type
- `src/backend/orchestration/index.ts` - Updated comment for domain-bridges
- `src/backend/server.ts` - Calls configureDomainBridges() at startup
- `src/backend/domains/session/chat/chat-message-handlers/handlers/*.ts` - 9 handlers converted to relative imports
- `src/backend/domains/session/chat/chat-message-handlers/interactive-response.ts` - Converted to relative import
- `src/backend/orchestration/ratchet-bridges.orchestrator.ts` - Deleted (merged into domain-bridges)
- `src/backend/domains/session/chat/chat-message-handlers.service.test.ts` - Updated mock paths and bridge configuration
- `src/backend/domains/session/chat/chat-message-handlers/interactive-response.test.ts` - Updated mock path
- `src/backend/services/chat-message-handlers.service.test.ts` - Updated mock paths and bridge configuration

## Decisions Made
- **Locally-defined types in bridges.ts:** Session bridges.ts defines `SessionInitPolicyInput.status` as `string` (not Prisma enum) to avoid cross-domain Prisma type dependency. The orchestrator casts at the boundary.
- **Cast at orchestration boundary:** `getWorkspaceInitPolicy(input as WorkspaceInitPolicyInput)` safely casts the bridge's string-typed input to the workspace domain's Prisma-typed input.
- **Merged ratchet-bridges into domain-bridges:** Single file consolidates all bridge wiring rather than separate per-domain orchestrators.
- **Intra-domain relative imports:** All 11 session handler files that imported `sessionService` through `@/backend/services/session.service` shim now use relative path `../../../lifecycle/session.service`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated test mock paths to match new relative import paths**
- **Found during:** Task 1
- **Issue:** Tests mocked `@/backend/services/session.service` but source now imports from relative paths. 3 test files (8 tests total) failed.
- **Fix:** Updated vi.mock paths in interactive-response.test.ts, chat-message-handlers.service.test.ts (domain), and chat-message-handlers.service.test.ts (shim-level). Added `configure()` calls for initPolicy bridge in test beforeEach.
- **Files modified:** 3 test files
- **Verification:** All 1785 tests pass
- **Committed in:** 408567ce (Task 1 commit)

**2. [Rule 1 - Bug] Fixed type mismatch in domain-bridges orchestrator**
- **Found during:** Task 2
- **Issue:** Two type errors: (1) `sessionService.getClient()` returns `undefined` not `null`, (2) `SessionInitPolicyInput.status` is `string` vs `WorkspaceStatus` enum.
- **Fix:** Added `?? null` coercion for getClient, `as WorkspaceInitPolicyInput` cast for init policy input.
- **Files modified:** domain-bridges.orchestrator.ts
- **Verification:** typecheck passes
- **Committed in:** 91d03eea (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 8 (Orchestration Layer) is fully complete: all 4 plans done
- All 6 domain modules have zero cross-domain imports
- All cross-domain flows go through orchestration layer (workspace-init, workspace-archive orchestrators) or typed bridge interfaces
- Ready for Phase 9 (AppContext & Import Rewiring) to remove shim files and consolidate app-context

---
*Phase: 08-orchestration-layer*
*Completed: 2026-02-10*
