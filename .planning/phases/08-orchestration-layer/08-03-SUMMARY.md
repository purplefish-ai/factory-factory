---
phase: 08-orchestration-layer
plan: 03
subsystem: orchestration
tags: [bridges, dependency-injection, cross-domain, configure-pattern]

# Dependency graph
requires:
  - phase: 08-01
    provides: orchestration directory with workspace-init and workspace-archive orchestrators
  - phase: 08-02
    provides: ratchet bridge interfaces and configure() pattern on all ratchet services
provides:
  - configureRatchetBridges() wiring function called at server startup
  - workspace domain bridge interfaces (WorkspaceSessionBridge, WorkspaceGitHubBridge, WorkspacePRSnapshotBridge)
  - github domain bridge interfaces (GitHubSessionBridge, GitHubFixerBridge, GitHubKanbanBridge)
  - zero cross-domain imports in workspace-query, kanban-state, pr-review-fixer, pr-snapshot
affects: [08-04, 09-appcontext-import-rewiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [configure-bridge-getter, orchestrator-wiring-at-startup, direct-import-to-avoid-barrel-cycle]

key-files:
  created:
    - src/backend/orchestration/ratchet-bridges.orchestrator.ts
    - src/backend/domains/workspace/bridges.ts
    - src/backend/domains/github/bridges.ts
  modified:
    - src/backend/orchestration/index.ts
    - src/backend/server.ts
    - src/backend/domains/workspace/query/workspace-query.service.ts
    - src/backend/domains/workspace/state/kanban-state.ts
    - src/backend/domains/workspace/index.ts
    - src/backend/domains/github/pr-review-fixer.service.ts
    - src/backend/domains/github/pr-snapshot.service.ts
    - src/backend/domains/github/pr-snapshot.service.test.ts
    - src/backend/domains/github/index.ts

key-decisions:
  - "Direct import path for configureRatchetBridges to avoid barrel circular dep"
  - "Locally-defined fixer types in github/bridges.ts to avoid cross-domain dep on ratchet"
  - "Bridge injection in tests replacing vi.mock for cross-domain service mocks"

patterns-established:
  - "configure() + fail-fast getter for workspace and github domain services"
  - "Direct module import (not barrel) when barrel creates circular dependency"
  - "Locally-defined bridge types when reusing types from another domain would create a dep"

# Metrics
duration: 7min
completed: 2026-02-10
---

# Phase 8 Plan 03: Ratchet Bridge Wiring and Cross-Domain Import Removal Summary

**Ratchet bridges wired at startup via orchestrator; workspace-query, kanban-state, pr-review-fixer, and pr-snapshot converted to bridge injection with zero cross-domain imports**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-10T19:14:55Z
- **Completed:** 2026-02-10T19:22:53Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments
- Created configureRatchetBridges() orchestrator that wires session and github bridges into all four ratchet services at server startup
- Removed all cross-domain imports from workspace domain (workspace-query.service.ts, kanban-state.ts) using typed bridge interfaces
- Removed all cross-domain imports from github domain (pr-review-fixer.service.ts, pr-snapshot.service.ts) using typed bridge interfaces
- Updated test to use configure() bridge injection instead of vi.mock for removed dependencies

## Task Commits

Each task was committed atomically:

1. **Task 1: Create ratchet bridge wiring orchestrator** - `8a98fcd3` (feat)
2. **Task 2: Remove cross-domain imports from workspace-query, kanban-state, pr-review-fixer, and pr-snapshot** - `878e4e97` (feat)

## Files Created/Modified
- `src/backend/orchestration/ratchet-bridges.orchestrator.ts` - Constructs session and github bridges from domain singletons, configures all ratchet services
- `src/backend/orchestration/index.ts` - Updated with note about direct import for ratchet-bridges (barrel cycle avoidance)
- `src/backend/server.ts` - Added configureRatchetBridges() call before ratchetService.start()
- `src/backend/domains/workspace/bridges.ts` - Bridge interfaces for workspace domain cross-domain deps
- `src/backend/domains/workspace/query/workspace-query.service.ts` - Replaced 4 cross-domain imports with bridge getters
- `src/backend/domains/workspace/state/kanban-state.ts` - Replaced sessionService import with bridge
- `src/backend/domains/workspace/index.ts` - Exports workspace bridge types
- `src/backend/domains/github/bridges.ts` - Bridge interfaces for github domain cross-domain deps
- `src/backend/domains/github/pr-review-fixer.service.ts` - Replaced fixerSessionService and sessionService with bridges
- `src/backend/domains/github/pr-snapshot.service.ts` - Replaced kanbanStateService with bridge
- `src/backend/domains/github/pr-snapshot.service.test.ts` - Updated to use configure() bridge injection
- `src/backend/domains/github/index.ts` - Exports github bridge types

## Decisions Made
- **Direct import path for configureRatchetBridges**: The orchestration barrel re-exports would create a circular dependency (ratchet barrel -> reconciliation -> orchestration barrel -> ratchet-bridges -> ratchet barrel). Server.ts imports directly from ratchet-bridges.orchestrator instead.
- **Locally-defined fixer types in github/bridges.ts**: GitHubFixerAcquireInput/Result are defined locally in github/bridges.ts to avoid creating a cross-domain dependency from github -> ratchet domain.
- **Bridge injection in tests replacing vi.mock**: pr-snapshot test now uses prSnapshotService.configure({kanban: mock}) instead of vi.mock('@/backend/services/kanban-state.service'), matching the pattern established in Phase 8 Plan 02.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Circular dependency via orchestration barrel**
- **Found during:** Task 1 (ratchet bridge wiring orchestrator)
- **Issue:** Exporting configureRatchetBridges from orchestration/index.ts created a circular dep: ratchet/index.ts -> reconciliation.service -> orchestration/index.ts -> ratchet-bridges.orchestrator -> ratchet/index.ts
- **Fix:** Removed export from orchestration barrel; server.ts imports directly from ./orchestration/ratchet-bridges.orchestrator
- **Files modified:** src/backend/orchestration/index.ts, src/backend/server.ts
- **Verification:** pnpm deps:check passes with 0 violations
- **Committed in:** 8a98fcd3 (Task 1 commit)

**2. [Rule 1 - Bug] Type boundary conversions in bridge wiring**
- **Found during:** Task 1 (ratchet bridge wiring orchestrator)
- **Issue:** sessionService.getClient() returns ClaudeClient|undefined but bridge expects ...|null; computeCIStatus conclusion type mismatch (null|undefined vs undefined)
- **Fix:** Added `?? null` coercion for getClient, `?? undefined` coercion for conclusion field
- **Files modified:** src/backend/orchestration/ratchet-bridges.orchestrator.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** 8a98fcd3 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All ratchet, workspace, and github domain services now use bridge injection for cross-domain deps
- Plan 04 (remaining orchestration wiring) can proceed to wire workspace and github bridges
- Phase 9 (import rewiring) has clear bridge interfaces to wire at app-context level

## Self-Check: PASSED

All created files verified on disk. All commit hashes found in git log.

---
*Phase: 08-orchestration-layer*
*Completed: 2026-02-10*
