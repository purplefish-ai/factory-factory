---
phase: 20-event-translation-permissions
plan: 02
subsystem: api
tags: [acp, event-translation, permissions, websocket, session-delta, permission-bridge]

# Dependency graph
requires:
  - phase: 20-event-translation-permissions/01
    provides: AcpEventTranslator and AcpPermissionBridge isolated classes with tests
  - phase: 19-acp-runtime-foundation
    provides: AcpClientHandler, AcpRuntimeManager, session.service.ts ACP integration
provides:
  - End-to-end ACP event translation pipeline via AcpEventTranslator in session.service.ts
  - Permission bridge injection from session.service.ts through AcpRuntimeManager to AcpClientHandler
  - WebSocket protocol types extended with acpOptions and optionId for ACP permissions
  - ACP permission round-trip from SDK to user via WebSocket and back through bridge
affects: [20-03-frontend-permissions, frontend-permission-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AcpClientHandler forwards raw updates for centralized translation in session.service.ts"
    - "Permission bridge injected through handler types -> runtime manager -> client handler constructor chain"
    - "ACP permissions emit both delta (for WebSocket push) and pending interactive request (for session restore)"

key-files:
  created: []
  modified:
    - src/shared/claude/protocol/websocket.ts
    - src/shared/claude/protocol/interaction.ts
    - src/shared/websocket/chat-message.schema.ts
    - src/backend/domains/session/acp/acp-client-handler.ts
    - src/backend/domains/session/acp/acp-runtime-manager.ts
    - src/backend/domains/session/acp/index.ts
    - src/backend/domains/session/lifecycle/session.service.ts
    - src/backend/domains/session/chat/chat-message-handlers/handlers/permission-response.handler.ts
    - src/backend/domains/session/acp/acp-runtime-manager.test.ts

key-decisions:
  - "AcpClientHandler no longer translates events inline -- forwards raw SessionUpdate for centralized translation"
  - "Permission bridge instance created per-session in setupAcpEventHandler and stored in Map for later lookup"
  - "Bridge cleanup happens in both stopSession ACP path and onExit handler to prevent Promise leaks"
  - "ACP permission requests emit both delta event (UI rendering) and setPendingInteractiveRequest (session restore)"
  - "Logger parameter kept in AcpClientHandler constructor for API stability, prefixed with underscore as unused"

patterns-established:
  - "Constructor injection chain: session.service creates bridge -> passes via AcpRuntimeEventHandlers -> AcpRuntimeManager reads from handlers -> passes to AcpClientHandler"
  - "ACP permission response routing: optionId present -> bridge route, absent -> legacy Claude/Codex route"

# Metrics
duration: 5min
completed: 2026-02-13
---

# Phase 20 Plan 02: Event Translation + Permission Bridge Wiring Summary

**End-to-end ACP event translation via AcpEventTranslator and permission bridge injection chain from session.service.ts through runtime manager to client handler, with extended WebSocket types for multi-option permission UI**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-13T20:06:28Z
- **Completed:** 2026-02-13T20:12:27Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- ACP events now flow through AcpEventTranslator for full translation of all 11 SessionUpdate variants into delta events
- Permission requests suspend via AcpPermissionBridge injected through the constructor chain, replacing auto-approve
- WebSocket protocol types extended with acpOptions (permission_request) and optionId (permission_response) for frontend rendering
- Permission response handler routes ACP optionId through bridge, with fallback to legacy handler
- Session file logging preserved as first action in AcpClientHandler.sessionUpdate for all events
- All 2319 tests pass with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend shared types for ACP permission options and plan events** - `38144d67` (feat)
2. **Task 2: Wire translator and bridge into session service, runtime manager, and permission handler** - `3b5b3c4b` (feat)

## Files Created/Modified
- `src/shared/claude/protocol/websocket.ts` - Added acpOptions to permission_request payload type
- `src/shared/claude/protocol/interaction.ts` - Added acpOptions to PermissionRequest interface
- `src/shared/websocket/chat-message.schema.ts` - Added optional optionId to permission_response Zod schema
- `src/backend/domains/session/acp/acp-client-handler.ts` - Replaced inline switch with raw forwarding, added bridge injection
- `src/backend/domains/session/acp/acp-runtime-manager.ts` - Extended AcpRuntimeEventHandlers with permissionBridge, pass to constructor
- `src/backend/domains/session/acp/index.ts` - Added barrel exports for AcpEventTranslator and AcpPermissionBridge
- `src/backend/domains/session/lifecycle/session.service.ts` - Rewrote setupAcpEventHandler with translator and bridge, added respondToAcpPermission
- `src/backend/domains/session/chat/chat-message-handlers/handlers/permission-response.handler.ts` - Added ACP optionId routing through bridge
- `src/backend/domains/session/acp/acp-runtime-manager.test.ts` - Updated 3 tests for new forwarding behavior

## Decisions Made
- AcpClientHandler no longer does inline event translation -- all events forwarded as `acp_session_update` wrapper for centralized translation in session.service.ts via AcpEventTranslator
- Permission bridge created per-session in `setupAcpEventHandler` and stored in `acpPermissionBridges` Map on SessionService for later lookup by permission-response handler
- Bridge cleanup happens in both the `stopSession` ACP path and the `onExit` handler to prevent Promise leaks from multiple exit paths
- ACP permission requests emit both a delta event (for immediate WebSocket push to UI) and `setPendingInteractiveRequest` (for session restore on reconnect)
- Kept logger parameter in AcpClientHandler constructor (prefixed `_logger`) for API stability even though no longer used in method bodies

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed unused logger field causing TypeScript strict mode error**
- **Found during:** Task 2 (typecheck verification)
- **Issue:** After removing the inline switch, `this.logger` was no longer used in AcpClientHandler methods, causing TS6133 "declared but never read" error
- **Fix:** Removed private field storage, prefixed constructor parameter with underscore (`_logger`) to satisfy both TypeScript and Biome
- **Files modified:** src/backend/domains/session/acp/acp-client-handler.ts
- **Verification:** TypeScript compiles cleanly
- **Committed in:** 3b5b3c4b (Task 2 commit)

**2. [Rule 1 - Bug] Updated 3 existing AcpClientHandler tests for new forwarding behavior**
- **Found during:** Task 2 (test verification)
- **Issue:** Existing Phase 19 tests expected inline translation (acp_agent_message_chunk, acp_tool_call) but handler now forwards all events as acp_session_update wrapper
- **Fix:** Updated test expectations to match new forwarding pattern, changed "deferred events" test to verify ALL events are now forwarded
- **Files modified:** src/backend/domains/session/acp/acp-runtime-manager.test.ts
- **Verification:** All 2319 tests pass
- **Committed in:** 3b5b3c4b (Task 2 commit)

**3. [Rule 3 - Blocking] Added biome-ignore comments for async methods required by Client interface**
- **Found during:** Task 2 (lint verification)
- **Issue:** Biome useAwait rule flagged sessionUpdate and requestPermission as async without await, but async is required by @agentclientprotocol/sdk Client interface
- **Fix:** Added biome-ignore lint/suspicious/useAwait comments matching Phase 19 precedent
- **Files modified:** src/backend/domains/session/acp/acp-client-handler.ts
- **Verification:** Biome lint passes
- **Committed in:** 3b5b3c4b (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 blocking)
**Impact on plan:** All auto-fixes necessary for type correctness, test accuracy, and lint compliance. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- ACP event translation and permission bridge are fully wired end-to-end
- Frontend can receive permission_request deltas with acpOptions and send back optionId in permission_response
- Plan 03 can build the frontend permission UI components to render multi-option ACP permissions

---
## Self-Check: PASSED

All 9 modified files verified present. Both commit hashes (38144d67, 3b5b3c4b) confirmed in git log.

---
*Phase: 20-event-translation-permissions*
*Completed: 2026-02-13*
