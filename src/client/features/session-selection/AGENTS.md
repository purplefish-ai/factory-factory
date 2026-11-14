# Session selection feature

The launcher's choices for a new workspace's first session: provider and model,
thinking level, access, planning and Codex account, the draft that holds them,
and the launch settings they produce. Its model picker also serves the chat
composer and its Codex account choice the tab bars' new chat button. The
[features guide](../AGENTS.md) covers barrels and shared code. Bare file names
below are in this directory; paths that start with `src/` are from the
repository root.

## Owns, and does not own

This directory owns which options the launcher shows and keeps on screen, which
choices it validates and sends, and how a draft's explicit choices survive
provider switches, settings refetches and restoration. It does not own:

- Discovering and caching the options it shows: `getLaunchOptions` in
  `src/backend/services/session/service/config/` (its `AGENTS.md`).
- Checking explicit access again before the workspace is saved:
  `src/backend/orchestration/workspace-lifecycle/workspace-launch.orchestrator.ts`.
- The creation form and its stored drafts: `../kanban/`.
- Starting another conversation in an existing workspace, which offers no model,
  thinking, access or Plan choice, only a Codex account through
  `NewSessionAccountAction`: `../chat/use-session-collection-commands.ts`.
- Mapping a saved permission preset to a native access mode:
  `src/shared/session-launch.ts`.

## Public surface

`index.ts` exports `useSessionLaunchSelection`, `SessionLaunchControls` with
`AccessModeSelector` and `PlanningSelector`, `ProviderModelPicker` (also the
composer's model picker), `NewSessionAccountAction` (the tab bars' new chat
button), and the draft snapshot schema the Kanban draft storage validates.

## Invariants

- Validation and the creation payload use only options discovered for the
  selected model; while they load, earlier options from the same provider and
  account stay on screen, and creation sends only explicit choices.
  `use-session-launch-selection.test.tsx`.
- Once options are confirmed for the selected model, a saved permission preset
  with no matching native access blocks launch until the user picks one from
  Access, and launch never substitutes the provider's native default, which may
  grant more access than the preset. Before they are confirmed nothing blocks:
  the workspace is created and the start fails on the server.
  `use-session-launch-selection.test.tsx`,
  `src/backend/services/session/service/config/session.config.service.saved-access.test.ts`.
- An explicit thinking level the selected model lacks stays selected and blocks
  launch until the user picks a supported level or Default, while an inherited
  one falls back to the native default. `use-session-launch-selection.test.tsx`,
  `src/test-utils/session-launch-controls.integration.test.tsx`.

## Map

- `use-session-launch-selection.ts`: the draft, the options query and the launch
  settings; `launch-options-state.ts` resolves effective choices and which are
  invalid; `launch-selection-snapshot.ts` is the draft's restorable form.
- `session-launch-controls.tsx`: the thinking, Access and Plan controls.
- `provider-model-picker.tsx`, `provider-model-submenu.tsx`: provider and model.
- `new-session-account-action.tsx`: the Codex account choice for a new chat.
