---
phase: 21-config-options-unified-runtime
plan: 02
subsystem: ui
tags: [acp, config-options, react, dropdown, websocket, reducer, chat-input]

# Dependency graph
requires:
  - phase: 21-config-options-unified-runtime
    plan: 01
    provides: config_options_update WebSocket message type, set_config_option handler, configOptions on AcpProcessHandle
provides:
  - AcpConfigOption types with flat and grouped option support
  - CONFIG_OPTIONS_UPDATE reducer action and acpConfigOptions state
  - config_options_update WebSocket message handler dispatching to reducer
  - setConfigOption action sending set_config_option via WebSocket
  - AcpConfigSelector generic dropdown component for agent-provided options
  - Chat input integration: ACP selectors replace legacy controls when config options present
affects: [21-03, ACP session UI, config option rendering]

# Tech tracking
tech-stack:
  added: []
  patterns: [agent-authoritative config rendering, conditional legacy/ACP control switching]

key-files:
  created:
    - src/components/chat/chat-input/components/acp-config-selector.tsx
  modified:
    - src/components/chat/reducer/types.ts
    - src/components/chat/reducer/state.ts
    - src/components/chat/reducer/slices/settings.ts
    - src/components/chat/reducer/index.ts
    - src/components/chat/use-chat-websocket.ts
    - src/components/chat/use-chat-state.ts
    - src/components/chat/use-chat-actions.ts
    - src/components/chat/chat-input/chat-input.tsx
    - src/client/routes/projects/workspaces/workspace-detail-chat-content.tsx
    - src/client/routes/projects/workspaces/workspace-detail-container.tsx

key-decisions:
  - "AcpConfigOption uses union type (AcpConfigOptionValue | AcpConfigOptionGroup) for flat and grouped option arrays"
  - "ACP config selectors fully replace legacy model/reasoning/thinking controls when acpConfigOptions present"
  - "No optimistic state update on setConfigOption -- wait for authoritative config_options_update from server"
  - "Props threaded through container -> chat content -> chat input for clean data flow"

patterns-established:
  - "Conditional control rendering: hasAcpConfigOptions gates entire legacy control block vs ACP selectors"
  - "AcpConfigSelector follows ModelSelector visual pattern (ghost variant, h-6, text-xs, ChevronDown)"

# Metrics
duration: 6min
completed: 2026-02-13
---

# Phase 21 Plan 02: Frontend Config Options UI Summary

**AcpConfigSelector dropdown component with flat/grouped option support, reducer state management for config_options_update, and chat-input integration replacing legacy controls for ACP sessions**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-13T22:52:41Z
- **Completed:** 2026-02-13T22:59:36Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- AcpConfigOption types with discriminated flat/grouped option union for SDK SessionConfigSelectOptions compatibility
- CONFIG_OPTIONS_UPDATE action in settings reducer slice with WebSocket message handler
- setConfigOption action sends set_config_option messages without optimistic state update (agent-authoritative)
- AcpConfigSelector component handles both flat option lists and grouped option lists with DropdownMenuLabel headers
- Chat input LeftControls conditionally renders ACP config selectors when acpConfigOptions present, hiding legacy model/reasoning/thinking controls
- Full prop threading from workspace container through chat content to chat input

## Task Commits

Each task was committed atomically:

1. **Task 1: Reducer state, actions, and WebSocket message handling for config options** - `a588ffd5` (feat)
2. **Task 2: AcpConfigSelector component and chat-input integration** - `50d946e7` (feat)

## Files Created/Modified
- `src/components/chat/chat-input/components/acp-config-selector.tsx` - NEW: Generic config option dropdown with flat/grouped option rendering
- `src/components/chat/reducer/types.ts` - Added AcpConfigOption, AcpConfigOptionValue, AcpConfigOptionGroup types and CONFIG_OPTIONS_UPDATE action
- `src/components/chat/reducer/state.ts` - Added acpConfigOptions: null to initial, base reset, and session switch reset states
- `src/components/chat/reducer/slices/settings.ts` - Added handleConfigOptionsUpdate function and CONFIG_OPTIONS_UPDATE case
- `src/components/chat/reducer/index.ts` - Wired config_options_update WebSocket message to CONFIG_OPTIONS_UPDATE action, exported new types
- `src/components/chat/use-chat-websocket.ts` - Exposed acpConfigOptions and setConfigOption in return interface and value
- `src/components/chat/use-chat-state.ts` - Added setConfigOption to UseChatStateReturn interface
- `src/components/chat/use-chat-actions.ts` - Added setConfigOption action sending set_config_option via WebSocket
- `src/components/chat/chat-input/chat-input.tsx` - AcpConfigSelector integration in LeftControls with conditional legacy/ACP rendering
- `src/client/routes/projects/workspaces/workspace-detail-chat-content.tsx` - Threading acpConfigOptions and setConfigOption props
- `src/client/routes/projects/workspaces/workspace-detail-container.tsx` - Destructuring acpConfigOptions and setConfigOption from useChatWebSocket

## Decisions Made
- Used union type `AcpConfigOptionValue | AcpConfigOptionGroup` for options array to handle both flat and grouped option lists from the SDK
- ACP config selectors fully replace legacy model/reasoning/thinking controls when `acpConfigOptions` is non-null with entries -- no mixing of legacy and ACP controls
- setConfigOption does NOT optimistically update state -- waits for authoritative config_options_update response from server per anti-pattern identified in research
- Props threaded through the existing container -> chat content -> chat input chain rather than creating a separate context provider

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added setConfigOption to UseChatStateReturn interface**
- **Found during:** Task 1 (typecheck verification)
- **Issue:** TypeScript error: `Property 'setConfigOption' does not exist on type 'UseChatStateReturn'` -- the interface explicitly lists all action properties rather than inferring from UseChatActionsReturn
- **Fix:** Added `setConfigOption: (configId: string, value: string) => void` to UseChatStateReturn interface
- **Files modified:** src/components/chat/use-chat-state.ts
- **Verification:** pnpm typecheck passes
- **Committed in:** a588ffd5 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Type interface update required for TypeScript compilation. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Frontend config options UI is complete and ready for end-to-end ACP config option flow
- AcpConfigSelector renders when config_options_update events arrive from backend
- set_config_option messages flow from UI selection through WebSocket to backend handler
- Plan 03 (unified runtime) can build on the complete config options pipeline

## Self-Check: PASSED

All 11 files verified present. Both task commits (a588ffd5, 50d946e7) verified in git log.

---
*Phase: 21-config-options-unified-runtime*
*Completed: 2026-02-13*
