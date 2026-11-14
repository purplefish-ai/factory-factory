# Agents feature: the Automations page

The Automations page: scheduled automations (`PeriodicTask`) and event
automations (`AgentDefinition`), their list rail, the saved event detail and
editor, the Runs and Events history, Enable, Pause, Reset source, Delete and run
recovery. The [features guide](../AGENTS.md) covers barrels and shared code.
Bare file names below are in this directory; paths that start with `src/` are
from the repository root.

## Owns, and does not own

This directory owns what the page reads, when it reads it, and what each write
sends. It does not own:

- The `automation` procedures and what they guarantee:
  `src/backend/trpc/agent.trpc.ts` and the
  [agent-definition capsule guide](../../../backend/services/agent-definition/AGENTS.md).
- Which cached reads each write invalidates:
  `src/client/lib/agent-query-cache.ts`.
- The Runs tab of a workspace an event run started:
  `src/client/features/workspace/automation-origin-panel.tsx`.
- The chat proposal card: `src/client/features/agent-authoring/`.
- The routes that compose the page: `src/client/routes/agents/`.

## Public surface

`index.ts` exports the scheduled run history query, the schedule helpers and
fields, and `EventRunItem`.

## Invariants

- A saved edit sends the `managementRevision` captured when editing began;
  polling and a `CONFLICT` keep it and every entered field, and only **Discard
  edits and reload** adopts a newer one. `event-agents-page.test.tsx`.
- Draft validation and source discovery run only when the user asks, and a
  result that returns after the draft or the selection changed is dropped.
  `event-agents-page.test.tsx`, `event-agent-continuation.test.tsx`.
- Every displayed state of an automation and its triggers comes from the
  configured triggers, never the definition's `isEnabled`; a trigger listens
  only when it is enabled and `ACTIVE`. `event-trigger-status.test.tsx`,
  `event-agent-activation.test.tsx`.
- Run recovery reads `recoveryTarget` and then `inspectRun` only when Inspect
  opens, afresh on every opening, and never again while the dialog stays open.
  `event-run-recovery.test.tsx`.
- A recovery action sends the inspected context unchanged; after a `CONFLICT` or
  `BLOCKED` result nothing is sent again until **Reload** reads the target
  afresh. `event-run-recovery.test.tsx`.
- Only **Abandon anyway** sends `acceptUnprovenStop: true`.
  `event-run-recovery.test.tsx`.
- In an archived project the detail stays readable and Edit, Enable, Pause,
  Reset source, Delete and Inspect are disabled. `event-agents-page.test.tsx`,
  `event-agent-activation.test.tsx`, `event-agent-delete.test.tsx`,
  `event-run-recovery.test.tsx`.
- A history whose first read failed shows an error, never an empty state, and
  only a `LIVE` run links to its workspace. `event-run-history.test.tsx`,
  `event-evaluation-history.test.tsx`.

## Map

- `agents-page.tsx`, `agents-dashboard-shell.tsx`, `use-agents-controller.ts`:
  the page, its rail and scheduled automations.
- `event-agent-selection.tsx`: the selected event automation and its retained
  trigger pages; `event-agent-detail.tsx`: its saved detail;
  `saved-event-editor.tsx`, `event-agent-editor.tsx`,
  `use-event-agent-editor.ts`, `event-agent-draft.ts`: the editor.
- `event-trigger-status.tsx`: trigger, automation and source states in words.
- `event-agent-activation.tsx`, `event-source-reset.tsx`,
  `event-agent-delete.tsx`: Enable and Pause, Reset source, Delete.
- `event-agent-history.tsx`, `event-history-frame.tsx`, `event-run-history.tsx`,
  `event-evaluation-history.tsx`, `event-history-reasons.ts`: the Runs and
  Events tabs.
- `event-run-recovery.tsx`, `event-run-recovery-copy.ts`: Inspect and its
  Resolve, Retry and Abandon dialogs.
