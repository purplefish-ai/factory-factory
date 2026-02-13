---
phase: 21-config-options-unified-runtime
plan: 03
subsystem: api
tags: [acp, unified-runtime, session-service, useAcp-removal, deprecation]

# Dependency graph
requires:
  - phase: 21-config-options-unified-runtime
    plan: 01
    provides: AcpRuntimeManager, AcpProcessHandle, configOptions lifecycle, createOrResumeSession
  - phase: 21-config-options-unified-runtime
    plan: 02
    provides: AcpConfigSelector frontend, config_options_update reducer, setConfigOption actions
provides:
  - Unified ACP runtime path for all new sessions (both Claude and Codex)
  - useAcp flag completely removed from codebase
  - buildAcpChatBarCapabilities deriving capabilities from ACP configOptions
  - Legacy runtime managers deprecated with JSDoc for Phase 22 cleanup
affects: [22-cleanup, admin endpoints, session lifecycle, chat handler]

# Tech tracking
tech-stack:
  added: []
  patterns: [unified runtime path, legacy-to-ACP migration seam]

key-files:
  created: []
  modified:
    - src/backend/domains/session/lifecycle/session.service.ts
    - src/backend/domains/session/lifecycle/session.service.test.ts
    - src/backend/routers/websocket/chat.handler.ts
    - src/backend/domains/session/runtime/index.ts
    - src/backend/domains/session/index.ts

key-decisions:
  - "All new sessions route through AcpRuntimeManager regardless of provider -- legacy adapters only used for already-running sessions"
  - "Removed createClaudeClient, createCodexClient, loadCodexSessionContext, buildClientOptions, buildClientEventHandlers as dead code"
  - "buildAcpChatBarCapabilities derives model/thinking capabilities from configOptions categories"
  - "Legacy runtime managers kept but deprecated with JSDoc for Phase 22 cleanup"

patterns-established:
  - "Unified runtime: getOrCreateSessionClient always routes new sessions to ACP, checks legacy adapters only for existing clients"
  - "Deprecation annotation: @deprecated JSDoc on legacy singleton exports signals Phase 22 removal"

# Metrics
duration: 10min
completed: 2026-02-13
---

# Phase 21 Plan 03: Unified AcpRuntimeManager Summary

**All new sessions (Claude and Codex) route through AcpRuntimeManager exclusively, useAcp flag removed, legacy runtime managers deprecated for Phase 22 cleanup**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-13T23:02:02Z
- **Completed:** 2026-02-13T23:12:53Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- getOrCreateSessionClient always routes new sessions to AcpRuntimeManager (no useAcp flag, no legacy branch)
- Existing legacy sessions (already running via ClaudeRuntimeManager or CodexAppServerManager) continue working until natural exit
- Removed 5 dead private methods from SessionService (~150 lines): createClaudeClient, createCodexClient, loadCodexSessionContext, buildClientOptions, buildClientEventHandlers
- Added buildAcpChatBarCapabilities to derive ChatBarCapabilities from ACP configOptions (model category, thought_level category)
- useAcp flag completely eliminated from entire codebase (zero grep results)
- Legacy runtime managers annotated with @deprecated JSDoc for Phase 22 cleanup
- Session service tests updated to mock acpRuntimeManager and test the unified ACP path

## Task Commits

Each task was committed atomically:

1. **Task 1: Route all new sessions through AcpRuntimeManager, remove useAcp flag** - `8c4ea9de` (feat)
2. **Task 2: Clean up runtime barrel exports and session domain barrel** - `0764b65b` (chore)

## Files Created/Modified
- `src/backend/domains/session/lifecycle/session.service.ts` - Unified ACP path in getOrCreateSessionClient, removed dead legacy creation methods, added buildAcpChatBarCapabilities
- `src/backend/domains/session/lifecycle/session.service.test.ts` - Added acpRuntimeManager mock, updated 8 tests from legacy to ACP path assertions
- `src/backend/routers/websocket/chat.handler.ts` - Removed useAcp: true flag from getOrCreateSessionClient call
- `src/backend/domains/session/runtime/index.ts` - Added @deprecated JSDoc to ClaudeRuntimeManager and CodexAppServerManager exports
- `src/backend/domains/session/index.ts` - Added @deprecated JSDoc to legacy runtime manager re-exports

## Decisions Made
- All new sessions route through AcpRuntimeManager regardless of provider. Legacy adapters (Claude, Codex) only serve already-running sessions.
- Removed 5 private methods that were dead code after removing the legacy creation branch: createClaudeClient, createCodexClient, loadCodexSessionContext, buildClientOptions, buildClientEventHandlers
- buildAcpChatBarCapabilities derives capabilities from configOptions: model category enables model selection, thought_level category enables thinking toggle
- Legacy runtime managers kept functional (Phase 22 cleanup) but annotated with @deprecated JSDoc

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript error in getOrCreateAcpSessionClient argument passing**
- **Found during:** Task 1 (typecheck verification)
- **Issue:** `options` parameter was optional in `getOrCreateSessionClient` but required in `getOrCreateAcpSessionClient`, causing TS2345
- **Fix:** Pass `options ?? {}` to provide default empty object
- **Files modified:** src/backend/domains/session/lifecycle/session.service.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** 8c4ea9de (Task 1 commit)

**2. [Rule 1 - Bug] Updated test suite to use ACP mocks instead of legacy adapter mocks**
- **Found during:** Task 1 (test verification)
- **Issue:** 8 tests expected legacy `claudeSessionProviderAdapter.getOrCreateClient` calls, but all new sessions now route through ACP. Tests spawned real ACP binary (ENOENT)
- **Fix:** Added `acpRuntimeManager` mock via vi.mock, updated 8 tests to assert ACP path behavior, used MockAcpEventTranslator/MockAcpPermissionBridge classes instead of vi.fn() (constructor compatibility)
- **Files modified:** src/backend/domains/session/lifecycle/session.service.test.ts
- **Verification:** All 140 test files pass (2319 tests)
- **Committed in:** 8c4ea9de (Task 1 commit)

**3. [Rule 3 - Blocking] Fixed AcpProcessHandle type assertion in test mocks**
- **Found during:** Task 1 (pre-commit hook typecheck)
- **Issue:** `unsafeCoerce()` without type parameter returned `unknown`, incompatible with `AcpProcessHandle` parameter of `acpRuntimeManager.getOrCreateClient.mockResolvedValue()`
- **Fix:** Added `unsafeCoerce<AcpProcessHandle>()` with explicit generic type parameter
- **Files modified:** src/backend/domains/session/lifecycle/session.service.test.ts
- **Verification:** pnpm typecheck passes, pre-commit hook passes
- **Committed in:** 8c4ea9de (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 blocking)
**Impact on plan:** All auto-fixes necessary for TypeScript compilation and test compatibility after the runtime path change. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 21 (Config Options + Unified Runtime) is complete
- All sessions use ACP runtime exclusively -- the ACP cutover is functionally complete
- Phase 22 (Cleanup + Polish) can now safely:
  - Remove ClaudeRuntimeManager and CodexAppServerManager (annotated @deprecated)
  - Remove legacy provider adapter creation paths
  - Replace admin endpoints with ACP-based process reporting
  - Clean up remaining legacy protocol code

## Self-Check: PASSED

All 5 modified files verified present. Both task commits (8c4ea9de, 0764b65b) verified in git log.

---
*Phase: 21-config-options-unified-runtime*
*Completed: 2026-02-13*
