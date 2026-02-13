---
phase: 19-acp-runtime-foundation
plan: 02
subsystem: runtime
tags: [acp, session-service, event-pipeline, domain-barrel, provider-wiring, streaming]

# Dependency graph
requires:
  - phase: "19-01"
    provides: "AcpRuntimeManager, AcpProcessHandle, AcpClientHandler, AcpRuntimeEventHandlers"
provides:
  - "ACP session lifecycle wired into SessionService (create -> prompt -> stream -> cancel -> stop)"
  - "ACP event forwarding through emitDelta -> WebSocket pipeline (same as Claude/Codex)"
  - "ACP detection in sendSessionMessage and stopSession (RUNTIME-05 / RUNTIME-06)"
  - "Session domain barrel exports for all ACP public API types and singletons"
  - "ACP client creation via useAcp flag in getOrCreateSessionClient"
affects:
  - "20 (event translation + permissions)"
  - "21 (config options + unified runtime)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ACP provider detection via acpRuntimeManager.getClient(sessionId) at runtime inside existing API methods"
    - "useAcp opt-in flag for ACP session creation (safe for production, no activation without explicit flag)"
    - "ACP event forwarding via setupAcpEventHandler -> sessionDomainService.emitDelta (reuses proven pipeline)"
    - "Fire-and-forget prompt dispatch with error logging (same pattern as Codex path)"

key-files:
  created: []
  modified:
    - "src/backend/domains/session/lifecycle/session.service.ts"
    - "src/backend/domains/session/runtime/index.ts"
    - "src/backend/domains/session/index.ts"

key-decisions:
  - "ACP sessions detected at runtime via acpRuntimeManager.getClient() check inside existing sendSessionMessage/stopSession -- no new API routes needed"
  - "ACP event types mapped to existing delta pipeline types (acp_agent_message_chunk -> agent_message, acp_tool_call -> content_block_start, acp_tool_call_update -> tool_progress)"
  - "useAcp opt-in flag ensures ACP path only activates explicitly -- safe for production deployment"
  - "ACP prompt dispatch uses fire-and-forget pattern with error logging (matching Codex precedent)"

patterns-established:
  - "Provider wiring pattern: new provider paths added as opt-in branches in SessionService, detected at runtime via runtime manager getClient check"
  - "Event translation pattern: provider-specific events -> standardized delta types -> emitDelta -> WebSocket"
  - "Shutdown integration pattern: stopAllClients calls each runtime manager's stopAllClients in sequence"

# Metrics
duration: 5min
completed: 2026-02-13
---

# Phase 19 Plan 02: ACP Session Service Integration Summary

**ACP runtime wired into SessionService with create/prompt/stream/cancel/stop lifecycle, event pipeline forwarding via emitDelta, and runtime detection in existing WebSocket/tRPC handlers**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-13T17:34:12Z
- **Completed:** 2026-02-13T17:50:33Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- SessionService now has full ACP lifecycle: createAcpClient, sendAcpMessage, cancelAcpPrompt methods with runtime state management
- ACP event forwarding pipeline connected: AcpClientHandler.sessionUpdate -> onAcpEvent -> sessionDomainService.emitDelta -> publisher -> WebSocket (reuses proven Claude/Codex infrastructure)
- Existing API surface inherits ACP support: user-input.handler -> sendSessionMessage detects ACP (RUNTIME-05), stop.handler/session.trpc -> stopSession detects ACP (RUNTIME-06)
- Session domain barrel exports all ACP public types and singletons for downstream consumers

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire AcpRuntimeManager into session service and event pipeline** - `56b238a7` (feat)
2. **Task 2: Verify ACP integration end-to-end** - Human verification checkpoint (approved)

**Plan metadata:** `beefe17b` (docs: complete plan)

## Files Created/Modified
- `src/backend/domains/session/lifecycle/session.service.ts` - Added ACP client creation, send, cancel, stop methods; ACP branches in getOrCreateSessionClient, sendSessionMessage, stopSession, stopAllClients; ACP checks in isSessionRunning/isSessionWorking/isAnySessionWorking; setupAcpEventHandler for delta pipeline wiring
- `src/backend/domains/session/runtime/index.ts` - Added AcpRuntimeManager, AcpProcessHandle, AcpRuntimeEventHandlers, AcpClientOptions exports
- `src/backend/domains/session/index.ts` - Added ACP section with AcpClientOptions, AcpSessionState, AcpClientHandler, AcpProcessHandle, AcpRuntimeManager, acpRuntimeManager, AcpRuntimeEventHandlers exports

## Decisions Made
- ACP sessions detected at runtime via `acpRuntimeManager.getClient(sessionId)` inside existing `sendSessionMessage` and `stopSession` methods -- no new tRPC routes or WebSocket handlers needed (RUNTIME-05, RUNTIME-06)
- ACP event types translated to existing delta types: `acp_agent_message_chunk` -> `agent_message`, `acp_tool_call` -> `content_block_start` (tool_use), `acp_tool_call_update` -> `tool_progress`
- `useAcp` opt-in boolean flag gates ACP session creation -- safe for production with no accidental activation
- ACP prompt dispatch uses fire-and-forget pattern (`void this.sendAcpMessage(...)`) matching Codex precedent for non-blocking WebSocket response

## Deviations from Plan

None - plan executed exactly as written. All verification checks passed (typecheck, tests, lint).

## Issues Encountered
None - all implementation was additive alongside existing Claude/Codex paths with no conflicts.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 19 ACP Runtime Foundation is complete: isolated runtime module (Plan 01) + session service integration (Plan 02)
- AcpRuntimeManager has full lifecycle wired through SessionService with event streaming
- Ready for Phase 20: Event Translation + Permissions (richer event mapping, permission UI integration)
- Ready for Phase 21: Config Options + Unified Runtime (provider selection, configuration management)
- All existing tests pass with zero regressions, ACP paths are opt-in only

## Self-Check: PASSED

All 3 modified files verified on disk. Task 1 commit (56b238a7) verified in git log.

---
*Phase: 19-acp-runtime-foundation*
*Completed: 2026-02-13*
