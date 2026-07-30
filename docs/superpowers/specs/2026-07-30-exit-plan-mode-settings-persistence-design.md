# ExitPlanMode Settings Persistence Design

## Problem

Approving `ExitPlanMode` clears `chatSettings.planModeEnabled` in memory, but the
action flow does not update the session-scoped settings in `sessionStorage`.
Reloading can therefore restore the stale enabled value.

## Approaches considered

1. Persist only inside `approvePermission`. This follows the permission reducer
   closely, but misses the existing `answerQuestion` path that also completes an
   `ExitPlanMode` approval.
2. Synchronize plan mode from ACP config updates. This may eventually reinforce
   the state, but it does not cover Codex and would put persistence concerns too
   far from the user action that changes the setting.
3. Persist in the shared plan-approval completion helper. This keeps both
   approval entry paths consistent and mirrors the existing capability-clamped
   persistence pattern used by settings and model changes.

Approach 3 is selected.

## Design

`completeCodexPlanApproval` will continue to perform the shared local
`planModeEnabled: false` update needed by the question-response path. It will
also build a complete settings object from the state captured before approval,
override plan mode to `false`, clamp it against the current provider
capabilities, and persist it using the current database session id.

Provider-specific behavior remains unchanged: non-Codex providers may receive a
post-plan ACP mode update, while Codex receives the automatic `Approved`
message.

## Testing

An integration test will exercise the real `useChatState` action callback and
browser `sessionStorage`: enable and persist plan mode, approve an
`ExitPlanMode` permission request, then assert both current state and persisted
settings are disabled. The test will fail before the production change because
the stored value remains `true`.

Existing reducer tests continue to cover denial and unrelated-tool behavior.
The implementation conditions remain unchanged, so those paths do not invoke
the completion helper and cannot overwrite persisted plan mode.
