---
phase: 08-orchestration-layer
plan: 01
subsystem: orchestration
tags: [srp, orchestration, cross-domain, refactor, workspace-init, workspace-archive]

# Dependency graph
requires:
  - phase: 02-session-domain-consolidation
    provides: session domain barrel with sessionService, sessionDomainService, chatMessageHandlerService
  - phase: 03-workspace-domain-consolidation
    provides: workspace domain barrel with worktreeLifecycleService, workspaceStateMachine
  - phase: 04-github-domain-consolidation
    provides: github domain barrel with githubCLIService
  - phase: 05-ratchet-domain-consolidation
    provides: ratchet domain barrel
  - phase: 06-terminal-domain-consolidation
    provides: terminal domain barrel with terminalService
  - phase: 07-run-script-domain-consolidation
    provides: run-script domain barrel with runScriptService, startupScriptService
provides:
  - src/backend/orchestration/ directory with workspace-init and workspace-archive orchestrators
  - initializeWorkspaceWorktree standalone function in orchestration layer
  - archiveWorkspace standalone function in orchestration layer
  - Clean worktree-lifecycle.service.ts with zero cross-domain imports
  - Fixed tRPC layer violation in reconciliation.service.ts
affects: [09-appcontext-import-rewiring, 08-02, 08-03, 08-04]

# Tech tracking
tech-stack:
  added: []
  patterns: [orchestration-layer-pattern, direct-module-path-for-circular-avoidance]

key-files:
  created:
    - src/backend/orchestration/index.ts
    - src/backend/orchestration/types.ts
    - src/backend/orchestration/workspace-init.orchestrator.ts
    - src/backend/orchestration/workspace-archive.orchestrator.ts
  modified:
    - src/backend/domains/workspace/worktree/worktree-lifecycle.service.ts
    - src/backend/domains/workspace/worktree/worktree-init.test.ts
    - src/backend/domains/ratchet/reconciliation.service.ts
    - src/backend/domains/ratchet/reconciliation.service.test.ts
    - src/backend/domains/workspace/lifecycle/creation.service.ts
    - src/backend/domains/workspace/lifecycle/creation.service.test.ts
    - src/backend/trpc/workspace/init.trpc.ts
    - src/backend/trpc/workspace.trpc.ts
    - knip.json

key-decisions:
  - "clearInitMode made public on WorktreeLifecycleService for orchestrator access"
  - "Orchestrators use direct module paths for workspace domain to avoid circular dependency through barrel"
  - "creation.service.ts dynamic import targets orchestrator file directly, not barrel"
  - "Knip ignore added for orchestration directory"
  - "Module-level cached GitHub username in orchestrator (was instance field on class)"

patterns-established:
  - "Orchestration layer pattern: standalone functions importing from domain barrels for cross-domain coordination"
  - "Direct module path imports when barrel import would create circular dependency"

# Metrics
duration: 12min
completed: 2026-02-10
---

# Phase 08 Plan 01: Workspace Orchestration Extraction Summary

**Extracted initializeWorkspaceWorktree and archiveWorkspace from god-service into orchestration layer, eliminating 6 cross-domain imports from worktree-lifecycle.service.ts**

## Performance

- **Duration:** 12 min
- **Started:** 2026-02-10T18:54:12Z
- **Completed:** 2026-02-10T19:06:50Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- Created `src/backend/orchestration/` directory with workspace-init and workspace-archive orchestrators
- Stripped worktree-lifecycle.service.ts from 810 lines to 230 lines with zero cross-domain imports
- Fixed tRPC layer violation where reconciliation.service.ts imported from tRPC layer
- Updated all callers (init.trpc.ts, workspace.trpc.ts, creation.service.ts, reconciliation.service.ts) and their tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Create orchestration directory and extract orchestrators** - `73e06c04` (feat)
2. **Task 2: Strip extracted logic and update callers** - `fe598e11` (refactor)

## Files Created/Modified
- `src/backend/orchestration/index.ts` - Barrel file re-exporting orchestration functions
- `src/backend/orchestration/types.ts` - Shared WorkspaceWithProject type
- `src/backend/orchestration/workspace-init.orchestrator.ts` - initializeWorkspaceWorktree flow
- `src/backend/orchestration/workspace-archive.orchestrator.ts` - archiveWorkspace flow
- `src/backend/domains/workspace/worktree/worktree-lifecycle.service.ts` - Cleaned to pure worktree manager
- `src/backend/domains/workspace/worktree/worktree-init.test.ts` - Updated mocks for orchestrator imports
- `src/backend/domains/ratchet/reconciliation.service.ts` - Import from orchestration instead of tRPC
- `src/backend/domains/ratchet/reconciliation.service.test.ts` - Updated mock path
- `src/backend/domains/workspace/lifecycle/creation.service.ts` - Dynamic import targets orchestrator directly
- `src/backend/domains/workspace/lifecycle/creation.service.test.ts` - Updated mock path
- `src/backend/trpc/workspace/init.trpc.ts` - Import from orchestration, removed wrapper function
- `src/backend/trpc/workspace.trpc.ts` - Import archiveWorkspace from orchestration
- `knip.json` - Added orchestration directory to ignore list

## Decisions Made
- **clearInitMode made public:** The orchestrator needs to call `worktreeLifecycleService.clearInitMode()` which was previously private. Made it public since the orchestrator legitimately needs this capability.
- **Direct module paths for workspace domain:** Orchestrators import `workspaceStateMachine` and `worktreeLifecycleService` from their direct module files rather than the workspace barrel. This avoids a circular dependency: `workspace/index.ts -> creation.service.ts -> (dynamic) orchestrator -> workspace/index.ts`.
- **Module-level cached GitHub username:** Moved from instance field `cachedGitHubUsername` on WorktreeLifecycleService to a module-level variable in the orchestrator. This is cross-domain caching logic that belongs in the orchestration layer.
- **Knip ignore for orchestration:** Added `src/backend/orchestration/*.ts` to knip ignore since Task 1 creates the files before Task 2 wires up callers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] clearInitMode visibility change**
- **Found during:** Task 1 (orchestrator extraction)
- **Issue:** `clearInitMode` was private on WorktreeLifecycleService but the orchestrator needs to call it
- **Fix:** Changed from `private` to `public` visibility
- **Files modified:** src/backend/domains/workspace/worktree/worktree-lifecycle.service.ts
- **Verification:** Typecheck passes, all tests pass
- **Committed in:** 73e06c04 (Task 1 commit)

**2. [Rule 3 - Blocking] Circular dependency through workspace barrel**
- **Found during:** Task 2 (updating callers)
- **Issue:** depcruise detected circular: workspace barrel -> creation.service -> orchestrator -> workspace barrel
- **Fix:** Orchestrators import from direct module paths instead of workspace barrel; creation.service dynamic import targets orchestrator file directly
- **Files modified:** workspace-init.orchestrator.ts, workspace-archive.orchestrator.ts, creation.service.ts
- **Verification:** depcruise reports 0 violations
- **Committed in:** fe598e11 (Task 2 commit)

**3. [Rule 3 - Blocking] Knip reports orchestration files as unused**
- **Found during:** Task 1 (committing new files)
- **Issue:** New orchestration files have no callers yet (callers updated in Task 2)
- **Fix:** Added `src/backend/orchestration/*.ts` to knip ignore list
- **Files modified:** knip.json
- **Verification:** Knip passes with no unused file warnings for orchestration
- **Committed in:** 73e06c04 (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (3 blocking)
**Impact on plan:** All auto-fixes necessary for correctness. The circular dependency fix is an important pattern for future orchestration work. No scope creep.

## Issues Encountered
- Pre-existing uncommitted ratchet bridge changes (from Phase 8 research/plan 3 prep) interfered with the working directory; required multiple restores to keep changes isolated to plan 01 scope.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Orchestration directory established with the first two orchestrators
- Pattern validated: orchestrators import from domain barrels (or direct module paths when barrel creates circular)
- Ready for Phase 08 plans 02-04 (ratchet orchestration, CI monitor orchestration, etc.)
- All tests pass (1785/1785), typecheck clean, depcruise clean, knip clean

## Self-Check: PASSED

All created files verified present. All commit hashes verified in git log.

---
*Phase: 08-orchestration-layer*
*Completed: 2026-02-10*
