---
phase: 20-event-translation-permissions
plan: 03
subsystem: ui
tags: [react, acp, permissions, plan-view, websocket, reducer]

# Dependency graph
requires:
  - phase: 20-02
    provides: "ACP event translation, permission bridge, WebSocket type extensions"
provides:
  - "AcpPermissionPrompt with multi-option buttons (allow once/always, reject once/always)"
  - "AcpPlanView component for structured task list rendering"
  - "Clickable file location links on ACP tool progress events"
  - "ACP plan state management in chat reducer"
  - "optionId flow from permission UI through WebSocket to backend"
affects: [21-config-options, 22-cleanup-polish]

# Tech tracking
tech-stack:
  added: []
  patterns: ["ACP multi-option routing in PermissionPrompt via acpOptions guard", "ACP plan updates via task_notification JSON parsing with acp_plan discriminant"]

key-files:
  created:
    - src/components/chat/acp-plan-view.tsx
  modified:
    - src/components/chat/permission-prompt.tsx
    - src/components/chat/use-chat-actions.ts
    - src/components/chat/use-chat-state.ts
    - src/components/chat/use-chat-websocket.ts
    - src/components/chat/reducer/types.ts
    - src/components/chat/reducer/index.ts
    - src/components/chat/reducer/slices/tooling.ts
    - src/components/chat/reducer/state.ts
    - src/components/chat/agent-live-dock.tsx
    - src/shared/claude/protocol/websocket.ts
    - src/client/routes/projects/workspaces/workspace-detail-chat-content.tsx
    - src/client/routes/projects/workspaces/workspace-detail-container.tsx

key-decisions:
  - "AcpPermissionPrompt placed in same file as PermissionPrompt with acpOptions guard routing"
  - "ACP plan updates parsed from task_notification JSON with acp_plan type discriminant"
  - "Tool progress acpLocations rendered as clickable buttons dispatching acp-open-file custom events"
  - "acpPlan and toolProgress surfaced through full hook chain (reducer -> use-chat-state -> use-chat-websocket -> ChatContent -> AgentLiveDock)"

patterns-established:
  - "ACP option routing: permission.acpOptions guard before ExitPlanMode check in PermissionPrompt"
  - "ACP plan state: task_notification JSON parsing in reducer/index.ts handleTaskNotificationMessage"

# Metrics
duration: 9min
completed: 2026-02-13
status: checkpoint-pending
---

# Phase 20 Plan 03: ACP Frontend UI Summary

**ACP multi-option permission buttons, structured plan view with status/priority, and clickable tool file locations -- completing Phase 20 frontend features**

## Status

Tasks 1-2 complete. Task 3 (human-verify checkpoint) pending -- requires visual verification of all Phase 20 features end-to-end.

## Performance

- **Duration:** 9 min
- **Started:** 2026-02-13T20:14:56Z
- **Completed:** Tasks 1-2 at 2026-02-13T20:24:29Z (Task 3 pending)
- **Tasks:** 2/3 (checkpoint pending)
- **Files modified:** 13

## Accomplishments
- ACP permission requests render 4 distinct option buttons (allow once, allow always, deny once, deny always) with icon and color differentiation
- optionId flows through WebSocket permission_response message for ACP option selection
- AcpPlanView component renders structured task list with status icons (pending/in_progress/completed) and priority badges (high/medium/low)
- Tool progress events with acpLocations render as clickable file links in AgentLiveDock
- Full prop chain wired from reducer state through hooks to UI components
- Legacy binary Allow/Deny UI completely unchanged for non-ACP sessions

## Task Commits

Each task was committed atomically:

1. **Task 1: ACP multi-option permission UI and optionId response flow** - `3a9d7c0c` (feat)
2. **Task 2: ACP plan view, clickable tool locations, and plan state management** - `97c4f642` (feat)
3. **Task 3: Verify Phase 20 frontend features end-to-end** - CHECKPOINT PENDING

## Files Created/Modified
- `src/components/chat/acp-plan-view.tsx` - New AcpPlanView component with collapsible task list, status icons, priority badges
- `src/components/chat/permission-prompt.tsx` - Added AcpPermissionPrompt component with multi-option buttons
- `src/components/chat/use-chat-actions.ts` - Updated approvePermission to accept optional optionId
- `src/components/chat/use-chat-state.ts` - Updated approvePermission type signature
- `src/components/chat/use-chat-websocket.ts` - Exposed acpPlan and toolProgress in return type
- `src/components/chat/reducer/types.ts` - Added AcpPlanEntry, AcpPlanState, AcpToolLocation types; acpPlan state; ACP_PLAN_UPDATE action
- `src/components/chat/reducer/index.ts` - ACP plan parsing in task_notification; acpOptions passthrough; acpLocations passthrough
- `src/components/chat/reducer/slices/tooling.ts` - ACP_PLAN_UPDATE handler; acpLocations/acpKind in SDK_TOOL_PROGRESS
- `src/components/chat/reducer/state.ts` - acpPlan: null in initial and reset states
- `src/components/chat/agent-live-dock.tsx` - AcpPlanView rendering and clickable tool location links
- `src/shared/claude/protocol/websocket.ts` - acpLocations and acpKind on tool_progress message type
- `src/client/routes/projects/workspaces/workspace-detail-chat-content.tsx` - acpPlan and toolProgress props
- `src/client/routes/projects/workspaces/workspace-detail-container.tsx` - Wire acpPlan and toolProgress from hook to view

## Decisions Made
- AcpPermissionPrompt in same file as PermissionPrompt (colocation, shared types/helpers)
- ACP plan updates detected by JSON-parsing task_notification messages with type 'acp_plan' discriminant
- Tool file locations use window.dispatchEvent CustomEvent pattern for loose coupling
- acpPlan cleared on both CLEAR_CHAT and RESET_FOR_SESSION_SWITCH (via createBaseResetState)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Task 3 checkpoint requires visual verification of Phase 20 features
- Once verified, Phase 20 is complete and Phase 21 (Config Options + Unified Runtime) can begin

---
*Phase: 20-event-translation-permissions*
*Plan 03 Tasks 1-2 completed: 2026-02-13*
*Task 3: Checkpoint pending human verification*
