---
phase: 20-event-translation-permissions
plan: 01
subsystem: api
tags: [acp, event-translation, permissions, websocket, session-delta]

# Dependency graph
requires:
  - phase: 19-acp-runtime-foundation
    provides: AcpClientHandler with stub event forwarding and auto-approve permissions
provides:
  - AcpEventTranslator class mapping all 11 SessionUpdate variants to SessionDeltaEvent arrays
  - AcpPermissionBridge class with Promise-based permission suspension lifecycle
affects: [20-02-wiring, 20-03-frontend-permissions]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AcpEventTranslator follows CodexEventTranslator stateless class pattern"
    - "Promise-based bridge for async SDK callbacks requiring user input"
    - "Defensive translation: never throw, log warnings, return empty arrays"

key-files:
  created:
    - src/backend/domains/session/acp/acp-event-translator.ts
    - src/backend/domains/session/acp/acp-event-translator.test.ts
    - src/backend/domains/session/acp/acp-permission-bridge.ts
    - src/backend/domains/session/acp/acp-permission-bridge.test.ts
  modified: []

key-decisions:
  - "Used Extract<SessionUpdate, {}> for type narrowing in private translator methods"
  - "tool_call emits both content_block_start (for UI rendering) and tool_progress (for status/locations tracking)"
  - "tool_call_update signals completion via elapsed_time_seconds=0 to match existing tool progress tracking"
  - "plan events use task_notification with JSON.stringify for structured data (frontend Plan 03 will parse)"
  - "AcpPermissionBridge stores resolve callback and params separately for re-emit on session restore"

patterns-established:
  - "AcpEventTranslator: stateless, switch-based, returns SessionDeltaEvent[] per CodexEventTranslator precedent"
  - "AcpPermissionBridge: Map<requestId, { resolve, params }> for async permission lifecycle"
  - "Defensive ACP translation: optional chaining, nullish coalescing, warn+empty-return on malformed data"

# Metrics
duration: 5min
completed: 2026-02-13
---

# Phase 20 Plan 01: Event Translation + Permission Bridge Summary

**Stateless AcpEventTranslator mapping all 11 ACP SessionUpdate variants to FF delta events, plus Promise-based AcpPermissionBridge for async permission suspension**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-13T19:59:08Z
- **Completed:** 2026-02-13T20:03:42Z
- **Tasks:** 2
- **Files created:** 4

## Accomplishments
- AcpEventTranslator handles all 11 SessionUpdate variants (agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan, available_commands_update, usage_update, plus 4 deferred types)
- Defensive error handling throughout: malformed/missing data logs warnings and returns empty arrays, never throws
- AcpPermissionBridge manages Promise-based permission lifecycle with waitForUserResponse, resolvePermission, and cancelAll
- 34 total new unit tests (24 translator + 10 bridge), all passing alongside 25 existing ACP tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Build AcpEventTranslator with full SessionUpdate variant mapping** - `ee2d34dc` (feat)
2. **Task 2: Build AcpPermissionBridge with Promise-based suspension** - `98a00866` (feat)

## Files Created/Modified
- `src/backend/domains/session/acp/acp-event-translator.ts` - Stateless translator mapping ACP SessionUpdate to FF SessionDeltaEvent arrays
- `src/backend/domains/session/acp/acp-event-translator.test.ts` - 24 unit tests covering all variants, edge cases, and malformed data
- `src/backend/domains/session/acp/acp-permission-bridge.ts` - Promise-based bridge for suspending requestPermission until user responds
- `src/backend/domains/session/acp/acp-permission-bridge.test.ts` - 10 unit tests covering full lifecycle, concurrent permissions, and edge cases

## Decisions Made
- Used `Extract<SessionUpdate, { sessionUpdate: 'variant' }>` for type-safe narrowing in private methods
- tool_call emits two events: content_block_start (rendering) + tool_progress (status/locations), matching how the frontend processes tool calls
- tool_call_update signals completion via `elapsed_time_seconds: 0` to leverage existing tool progress tracking
- plan events encoded as JSON in task_notification message field (frontend Plan 03 will parse the structured acp_plan type)
- AcpPermissionBridge stores both the resolve callback and original params to support re-emit on session restore

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ToolCallLocation test data to use `path` instead of `uri`**
- **Found during:** Task 1 (AcpEventTranslator typecheck)
- **Issue:** Plan test examples used `{ uri: 'file:///...' }` but ACP SDK ToolCallLocation type requires `path` field
- **Fix:** Updated test data to use `{ path: '/foo/bar.ts' }` matching SDK type definition
- **Files modified:** src/backend/domains/session/acp/acp-event-translator.test.ts
- **Verification:** TypeScript compiles cleanly
- **Committed in:** ee2d34dc (Task 1 commit)

**2. [Rule 3 - Blocking] Added `void` operator to floating Promises in permission bridge tests**
- **Found during:** Task 2 (Biome lint pre-commit hook)
- **Issue:** Biome nursery rule `noFloatingPromises` flagged intentionally unresolved Promises in tests
- **Fix:** Added `void` operator before `bridge.waitForUserResponse()` calls where await is intentionally omitted
- **Files modified:** src/backend/domains/session/acp/acp-permission-bridge.test.ts
- **Verification:** Biome lint passes, all tests still pass
- **Committed in:** 98a00866 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both auto-fixes necessary for type correctness and lint compliance. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- AcpEventTranslator and AcpPermissionBridge are isolated, tested, and ready to be wired into session.service.ts and AcpClientHandler in Plan 02
- Both classes export cleanly from their modules
- All 59 ACP domain tests pass (24 translator + 10 bridge + 25 existing runtime manager)

---
## Self-Check: PASSED

All 5 files verified present. Both commit hashes (ee2d34dc, 98a00866) confirmed in git log.

---
*Phase: 20-event-translation-permissions*
*Completed: 2026-02-13*
