---
phase: 21-config-options-unified-runtime
plan: 01
subsystem: api
tags: [acp, config-options, websocket, session-resume, loadSession, setConfigOption]

# Dependency graph
requires:
  - phase: 20-event-translation-permissions
    provides: AcpEventTranslator, AcpProcessHandle, AcpRuntimeManager, delta pipeline
provides:
  - configOptions field on AcpProcessHandle for agent-authoritative config state
  - config_option_update translation in AcpEventTranslator
  - config_options_update WebSocket message type
  - setConfigOption method on AcpRuntimeManager
  - capability-gated loadSession session resume with fallback
  - set_config_option chat message handler
  - setSessionConfigOption method on SessionService
  - initial configOptions emission on ACP session start
  - setSessionModel/setSessionThinkingBudget delegation to config options for ACP
affects: [21-02, 21-03, frontend config selectors, chat capabilities]

# Tech tracking
tech-stack:
  added: []
  patterns: [agent-authoritative config options lifecycle, capability-gated session resume]

key-files:
  created:
    - src/backend/domains/session/chat/chat-message-handlers/handlers/set-config-option.handler.ts
  modified:
    - src/backend/domains/session/acp/acp-process-handle.ts
    - src/backend/domains/session/acp/acp-event-translator.ts
    - src/backend/domains/session/acp/acp-runtime-manager.ts
    - src/backend/domains/session/acp/types.ts
    - src/shared/claude/protocol/websocket.ts
    - src/shared/websocket/chat-message.schema.ts
    - src/shared/websocket/index.ts
    - src/backend/domains/session/chat/chat-message-handlers/registry.ts
    - src/backend/domains/session/lifecycle/session.service.ts
    - src/components/chat/reducer/index.ts

key-decisions:
  - "Loose configOptions type in WebSocket (not importing SDK types into shared module)"
  - "Extracted createOrResumeSession helper to keep createClient under Biome cognitive complexity limit"
  - "Config options emit as config_options_update delta (not chat_capabilities) to keep systems parallel"
  - "setSessionModel/setSessionThinkingBudget find matching configOption by category, return silently if no match"

patterns-established:
  - "Agent-authoritative config options: agent reports options, frontend renders, set_config_option round-trips through SDK"
  - "Capability-gated session resume: check agentCapabilities.loadSession before attempting loadSession, fall back to newSession on failure"

# Metrics
duration: 7min
completed: 2026-02-13
---

# Phase 21 Plan 01: Backend Config Options Lifecycle Summary

**ACP configOptions storage, translation, set/get lifecycle, session resume via loadSession, and set_config_option WebSocket handler wired through SessionService**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-13T22:42:13Z
- **Completed:** 2026-02-13T22:50:11Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- AcpProcessHandle stores configOptions from session/new or session/load response, providing agent-authoritative config state
- AcpEventTranslator translates config_option_update push notifications to config_options_update deltas that flow through the existing delta pipeline
- AcpRuntimeManager.setConfigOption calls SDK, updates handle, returns authoritative response
- Capability-gated session resume via loadSession with graceful fallback to newSession
- New set_config_option WebSocket message type validates, routes through handler to SessionService to ACP SDK
- SessionService emits initial configOptions on ACP session start and authoritative updates on set
- setSessionModel and setSessionThinkingBudget for ACP sessions delegate to config options by category

## Task Commits

Each task was committed atomically:

1. **Task 1: ACP config options storage, translation, and runtime manager methods** - `0d851228` (feat)
2. **Task 2: set_config_option handler, session service wiring, and config options emission** - `52d69951` (feat)

## Files Created/Modified
- `src/backend/domains/session/acp/acp-process-handle.ts` - Added configOptions: SessionConfigOption[] field
- `src/backend/domains/session/acp/acp-event-translator.ts` - Translates config_option_update to config_options_update delta
- `src/backend/domains/session/acp/acp-runtime-manager.ts` - setConfigOption method, createOrResumeSession with loadSession support, stores configOptions from responses
- `src/backend/domains/session/acp/types.ts` - Added resumeProviderSessionId to AcpClientOptions
- `src/shared/claude/protocol/websocket.ts` - Added config_options_update message type to WebSocketMessagePayloadByType and type map
- `src/shared/websocket/chat-message.schema.ts` - Added set_config_option Zod schema with configId and value
- `src/shared/websocket/index.ts` - Exported SetConfigOptionMessage type
- `src/backend/domains/session/chat/chat-message-handlers/handlers/set-config-option.handler.ts` - NEW: handles set_config_option WebSocket messages
- `src/backend/domains/session/chat/chat-message-handlers/registry.ts` - Registered set_config_option handler
- `src/backend/domains/session/lifecycle/session.service.ts` - setSessionConfigOption method, initial config emission, resume session ID passthrough, model/thinking delegation
- `src/components/chat/reducer/index.ts` - Added config_options_update to MessageHandlerMap (null handler for frontend plan)

## Decisions Made
- Used loose configOptions type in WebSocket types (id, name, description, type, category, currentValue, options: unknown[]) to avoid importing SDK types into the shared module
- Extracted createOrResumeSession as a private helper method in AcpRuntimeManager to keep createClient under Biome's cognitive complexity limit of 15
- Config options emit as config_options_update delta events (not chat_capabilities) to keep the two systems parallel during transition
- setSessionModel/setSessionThinkingBudget find matching configOption by category (model/thought_level), return silently if agent doesn't support that config category

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added config_options_update to frontend MessageHandlerMap**
- **Found during:** Task 1 (typecheck verification)
- **Issue:** Adding config_options_update to WebSocketMessagePayloadByType caused TypeScript error because the frontend MessageHandlerMap requires entries for all message types
- **Fix:** Added `config_options_update: null` entry to messageHandlers map in chat reducer
- **Files modified:** src/components/chat/reducer/index.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** 0d851228 (Task 1 commit)

**2. [Rule 3 - Blocking] Refactored createClient to reduce cognitive complexity**
- **Found during:** Task 1 (Biome lint verification)
- **Issue:** Adding loadSession logic to createClient pushed cognitive complexity from ~15 to 24, exceeding Biome's limit of 15. Also had non-null assertions that Biome forbids.
- **Fix:** Extracted session creation/resume logic into private createOrResumeSession helper method, used truthiness narrowing instead of non-null assertions
- **Files modified:** src/backend/domains/session/acp/acp-runtime-manager.ts
- **Verification:** pnpm check:fix passes with no errors
- **Committed in:** 0d851228 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes necessary for build/lint compliance. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Backend config options lifecycle is complete and ready for frontend rendering (Plan 02)
- config_options_update WebSocket events will be received by frontend once handler is wired
- set_config_option messages can be sent from frontend once UI selectors are built
- Session resume via loadSession will activate automatically when agents advertise the capability

## Self-Check: PASSED

All 12 files verified present. Both task commits (0d851228, 52d69951) verified in git log.

---
*Phase: 21-config-options-unified-runtime*
*Completed: 2026-02-13*
