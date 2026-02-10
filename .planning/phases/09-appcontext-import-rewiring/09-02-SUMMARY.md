---
phase: 09-appcontext-import-rewiring
plan: 02
subsystem: api
tags: [imports, barrel-files, tRPC, websocket, interceptors, domain-modules]

# Dependency graph
requires:
  - phase: 08-orchestration-layer
    provides: Domain barrel files with public APIs, bridge injection pattern
provides:
  - All external consumer files rewired to import from domain barrels
  - Zero shim imports remain in tRPC, WebSocket, interceptor, agent, util, or server files
affects: [09-appcontext-import-rewiring plan 03 (shim deletion)]

# Tech tracking
tech-stack:
  added: []
  patterns: [direct module path for circular dep avoidance, value export for class used as both type and value]

key-files:
  modified:
    - src/backend/trpc/workspace.trpc.ts
    - src/backend/trpc/session.trpc.ts
    - src/backend/trpc/github.trpc.ts
    - src/backend/trpc/admin.trpc.ts
    - src/backend/trpc/workspace/init.trpc.ts
    - src/backend/trpc/workspace/workspace-helpers.ts
    - src/backend/trpc/workspace/git.trpc.ts
    - src/backend/trpc/workspace/ide.trpc.ts
    - src/backend/routers/websocket/chat.handler.ts
    - src/backend/routers/websocket/terminal.handler.ts
    - src/backend/routers/mcp/terminal.mcp.ts
    - src/backend/routers/mcp/terminal.mcp.test.ts
    - src/backend/interceptors/pr-detection.interceptor.ts
    - src/backend/interceptors/conversation-rename.interceptor.ts
    - src/backend/agents/process-adapter.ts
    - src/backend/utils/conversation-analyzer.ts
    - src/backend/utils/conversation-analyzer.test.ts
    - src/backend/server.ts
    - src/backend/domains/session/index.ts

key-decisions:
  - "Direct module paths for circular dep avoidance in interceptors/utils"
  - "ClaudeClient exported as value (not type-only) from session barrel"
  - "worktreeLifecycleService instance methods replace free functions in init.trpc.ts"

patterns-established:
  - "Circular dep avoidance: import from domain/subdirectory instead of barrel when barrel creates cycle"
  - "Value+type class export: classes used as both type and value must be in value export block"

# Metrics
duration: 14min
completed: 2026-02-10
---

# Phase 09 Plan 02: External Consumer Import Rewiring Summary

**All 17+ consumer files rewired from shim imports to domain barrel imports, enabling safe shim deletion in Plan 03**

## Performance

- **Duration:** 14 min
- **Started:** 2026-02-10T20:37:55Z
- **Completed:** 2026-02-10T20:52:00Z
- **Tasks:** 2
- **Files modified:** 19

## Accomplishments
- All 8 tRPC router files rewired to domain barrel imports (workspace, session, ratchet, github, run-script)
- All 9 non-tRPC consumer files rewired (WebSocket handlers, interceptors, agents, utils, server.ts)
- init.trpc.ts updated to use worktreeLifecycleService instance methods directly
- terminal.mcp.test.ts mock paths updated to match new domain barrel imports
- Zero shim imports remain in any consumer file outside of domains/ and services/ directories

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewire tRPC routers** - `126f5bdc` (feat)
2. **Task 2: Rewire WebSocket handlers, interceptors, agents, utils, server.ts** - `72f9faf2` (feat)

## Files Created/Modified
- `src/backend/trpc/workspace.trpc.ts` - 6 shim imports replaced with ratchet/session/workspace barrels
- `src/backend/trpc/session.trpc.ts` - 3 shim imports replaced with session/workspace barrels
- `src/backend/trpc/github.trpc.ts` - 2 shim imports replaced with github/workspace barrels
- `src/backend/trpc/admin.trpc.ts` - 2 shim imports replaced with session/workspace barrels
- `src/backend/trpc/workspace/init.trpc.ts` - 6 shim imports replaced, worktreeLifecycleService instance methods
- `src/backend/trpc/workspace/workspace-helpers.ts` - workspace barrel import
- `src/backend/trpc/workspace/git.trpc.ts` - workspace barrel import
- `src/backend/trpc/workspace/ide.trpc.ts` - workspace barrel import
- `src/backend/routers/websocket/chat.handler.ts` - ClaudeClient type + ConnectionInfo + sessionDataService from session barrel
- `src/backend/routers/websocket/terminal.handler.ts` - sessionDataService/workspaceDataService from barrels
- `src/backend/routers/mcp/terminal.mcp.ts` - sessionDataService + terminalService from barrels
- `src/backend/routers/mcp/terminal.mcp.test.ts` - mock paths updated for domain barrels
- `src/backend/interceptors/pr-detection.interceptor.ts` - prSnapshotService from github barrel
- `src/backend/interceptors/conversation-rename.interceptor.ts` - SessionManager/sessionService via direct module paths
- `src/backend/agents/process-adapter.ts` - all Claude types from session barrel
- `src/backend/utils/conversation-analyzer.ts` - HistoryMessage from session/claude
- `src/backend/utils/conversation-analyzer.test.ts` - HistoryMessage from session/claude
- `src/backend/server.ts` - reconciliationService from ratchet barrel
- `src/backend/domains/session/index.ts` - ClaudeClient moved to value export

## Decisions Made
- **Direct module paths for circular dep avoidance:** conversation-rename.interceptor.ts and conversation-analyzer.ts import from `@/backend/domains/session/claude` and `@/backend/domains/session/lifecycle/session.service` instead of the barrel, because the barrel creates a circular dependency through the interceptor chain (session barrel -> chat-event-forwarder -> interceptors -> conversation-rename -> session barrel).
- **ClaudeClient as value export:** Moved from type-only export block to value export in session barrel because process-adapter.ts calls `ClaudeClient.create()` (uses it as a class value, not just a type).
- **worktreeLifecycleService instance methods:** init.trpc.ts now calls `worktreeLifecycleService.getInitMode()` and `.setInitMode()` instead of free-function wrappers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ClaudeClient type-only export prevented value usage**
- **Found during:** Task 2 (process-adapter.ts rewiring)
- **Issue:** ClaudeClient was in `export type { ... }` block in session barrel, but process-adapter.ts uses it as `ClaudeClient.create()` (value)
- **Fix:** Moved ClaudeClient from type export to value export in session/index.ts
- **Files modified:** src/backend/domains/session/index.ts
- **Verification:** TypeScript compiles, process-adapter.ts resolves ClaudeClient correctly
- **Committed in:** 72f9faf2 (Task 2 commit)

**2. [Rule 3 - Blocking] Circular dependency through session barrel**
- **Found during:** Task 2 (conversation-rename.interceptor.ts rewiring)
- **Issue:** Importing from `@/backend/domains/session` barrel created a cycle: session/index -> chat-event-forwarder -> interceptors -> conversation-rename -> session/index
- **Fix:** Used direct module paths (`session/claude`, `session/lifecycle/session.service`) instead of barrel
- **Files modified:** src/backend/interceptors/conversation-rename.interceptor.ts, src/backend/utils/conversation-analyzer.ts, src/backend/utils/conversation-analyzer.test.ts
- **Verification:** dependency-cruiser reports 0 violations
- **Committed in:** 72f9faf2 (Task 2 commit)

**3. [Rule 1 - Bug] terminal.mcp.test.ts mock paths mismatched new imports**
- **Found during:** Task 2 (terminal.mcp.ts rewiring)
- **Issue:** Test mocked `../../services/terminal.service` but terminal.mcp.ts now imports from `@/backend/domains/terminal`
- **Fix:** Updated mock paths and added missing `@/backend/domains/session` mock for sessionDataService
- **Files modified:** src/backend/routers/mcp/terminal.mcp.test.ts
- **Verification:** All 12 terminal.mcp tests pass
- **Committed in:** 72f9faf2 (Task 2 commit)

**4. [Rule 3 - Blocking] conversation-rename.interceptor.ts missing sessionService rewire**
- **Found during:** Task 2
- **Issue:** Plan listed SessionManager from claude/session but missed sessionService from services/session.service which was also a shim import
- **Fix:** Rewired sessionService to direct path `@/backend/domains/session/lifecycle/session.service`
- **Files modified:** src/backend/interceptors/conversation-rename.interceptor.ts
- **Verification:** TypeScript compiles, no circular deps
- **Committed in:** 72f9faf2 (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (1 bug, 3 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and circular dependency avoidance. No scope creep.

## Issues Encountered
- Pre-existing test failure in reconciliation.service.test.ts (2 tests) -- not caused by this plan's changes. Confirmed by running tests on clean HEAD before changes.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All external consumer files now import from domain barrels
- Zero shim imports remain in consumer files
- Ready for Plan 03: safe deletion of deprecated shim files

---
*Phase: 09-appcontext-import-rewiring*
*Completed: 2026-02-10*
