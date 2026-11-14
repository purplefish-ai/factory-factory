# Kanban feature

The project board: its Todo, Working, Waiting and Done columns (sections on
phones), the board filter and Waiting sort, workspace cards, issue intake, Quick
Chat and the workspace creation form with its drafts. The
[features guide](../AGENTS.md) covers barrels and shared code. Bare file names
below are in this directory; paths that start with `src/` are from the
repository root.

## Owns, and does not own

This directory owns how the board shows one project's workspace list: grouping
by `kanbanColumn`, filtering and ordering, phone sections, Archive All, issue
intake suppression while archives are pending, the creation form, its
per-project drafts and dropped images, and Quick Chat. It does not own:

- Which column a workspace is in: `kanbanColumn` comes from
  `src/shared/kanban-column-projection.ts`, a total map over status reason
  codes, so a code without a column fails `pnpm typecheck`.
- The workspace list and detail caches and their reconciliation with snapshots:
  the [client library guide](../../lib/AGENTS.md).
- The archive command and its optimistic removal:
  `src/client/features/workspace/use-workspace-archive-command.ts`.
- The sidebar and its Board link counts:
  `src/client/components/app-sidebar.tsx`. The workspace switcher:
  `src/client/routes/projects/workspaces/workspace-detail-header/workspace-switcher-dropdown.tsx`.
- Fetching assigned issues: `src/client/hooks/use-project-issues.ts`.
- Family menus: `src/client/features/workspace/workspace-family-navigation.tsx`.

## Public surface

`index.ts` exports the board, controls, card, columns, `KanbanProvider` and its
actions, the issue launch sheet and the board's image drop zone. The sidebar
(`src/client/components/app-sidebar.tsx`) imports the creation form, the issue
launch sheet and `workspace-creation-image-drop-zone.tsx` by path to keep its
lazy split points, and `src/client/routes/agents/event-agent-workspace-form.tsx`
reuses the creation form and its draft hooks.

Mount `KanbanProvider` keyed by project ID, as
`src/client/routes/projects/workspaces/components/workspaces-board-view.tsx`
does, so archive recovery, Quick Chat and the inline form start fresh on a
project switch.
`src/client/routes/projects/workspaces/components/workspaces-board-view.test.tsx`.

## Invariants

- Sorting returns a new array and never reorders the list it is given, so the
  cached list keeps snapshot order. `board-view.test.ts`.
- Done sorts by latest activity and Working by creation whatever the Waiting
  sort choice, which is one browser preference shared across projects and tabs.
  `board-view.test.ts`, `use-waiting-sort-order.test.tsx`.
- Archive All archives every workspace in its column from the unfiltered list,
  including cards the filter hides. `kanban-board.test.tsx`,
  `kanban-context.test.tsx`.
- Only a successful creation request clears the filter and, on phones, reveals
  Working; mounting, remounting or cancelling does neither.
  `kanban-board.test.tsx`, `mobile-board-sections.test.tsx`.
- An issue stays out of intake until every archive of its workspace has settled,
  including overlapping archives. `kanban-context.test.tsx`.

## Map

- `kanban-context.tsx`: `KanbanProvider`, the project's list, issues, archive,
  rename, ratchet and Quick Chat actions, and issue suppression.
- `kanban-board.tsx`: columns on desktop, `mobile-board-sections.tsx` on phones;
  `board-view.ts` filters and sorts, `use-waiting-sort-order.ts` stores the
  Waiting choice, `waiting-sort-menu.tsx` offers it.
- `kanban-column.tsx` (`getKanbanColumns`: Todo is the provider's issue column),
  `kanban-card.tsx`, `kanban-card-status-chip.tsx`, `kanban-pr-states.tsx`,
  `kanban-family-highlight.tsx` (family hover outside React state).
- `kanban-controls.tsx`, `board-view-controls.tsx`: header controls and filter.
- `issues-column.tsx`, `issue-card.tsx`, `issue-launch-sheet.tsx`: Todo and its
  in-app issue launch.
- `inline-workspace-form.tsx`, `workspace-creation-options.tsx`,
  `use-workspace-creation-submission.ts`: the creation form and its request.
- `workspace-creation-draft-storage.ts` (IndexedDB),
  `use-workspace-creation-draft.ts`, `use-inline-workspace-draft.ts`,
  `workspace-draft-revisions.ts`: one draft per project.
- `workspace-creation-drop-queue.ts`: images dropped before draft storage loads
  wait in this in-memory queue, so a refresh before the drain loses them;
  `workspace-creation-drop-drain.tsx` appends them to the draft.
  `kanban-image-drop-zone.tsx`, `workspace-creation-image-drop-zone.tsx`: the
  board's and the sidebar's drop targets.
- `quick-chat-sheet.tsx`, `quick-chat-content.tsx`, `use-quick-chat.ts`.
