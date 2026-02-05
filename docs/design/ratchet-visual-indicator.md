# Ratchet Visual Indicator

## Current UX Contract

Ratcheting is represented everywhere by a hammer icon button with three states:

1. **Off**: gray hammer, no ants border
2. **On + idle**: normal hammer, static dashed ants border
3. **On + processing**: normal hammer, animated crawling ants border

The same control appears in:

- Workspace header
- Sidebar workspace rows
- Kanban cards

## State Mapping

`processing` is only true when both conditions are true:

- `workspace.ratchetEnabled === true`
- `workspace.ratchetState` is one of `CI_RUNNING`, `CI_FAILED`, `MERGE_CONFLICT`, `REVIEW_PENDING`

All other `ratchetState` values (`IDLE`, `READY`, `MERGED`) render as **On + idle** when enabled.

## Interaction Rules

- Clicking the hammer toggles `workspace.ratchetEnabled`.
- Toggling is always available at workspace level.
- Global ratchet setting in Admin is **only** the default for new GitHub-issue-created workspaces.
- Reduced motion disables ants animation while preserving a visible dashed border.

## Notes

- Previous `ratchet-active` and glow-based signaling were removed in favor of this single control.
