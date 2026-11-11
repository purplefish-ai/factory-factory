# Design Doc: Renamed Workspaces Keep Showing the Old Label

> **Status:** Header fix implemented. The workspace header now shows the
> workspace name, with the branch in its hover text. The reported Kanban defect
> could not be reproduced, so no Kanban change is made until the data listed in
> "Kanban: open investigation" is available.

## Summary

Renaming a workspace saves correctly: reopening the rename field shows the new
name. The workspace view still appears unchanged because **its header does not
display the workspace name.** Whenever a workspace has a branch, the header
displays the branch, and a rename never changes the branch.

This is a display-selection bug, not a persistence or cache bug. Storage, the
snapshot stream, and the client caches all carried the new name in every
reproduction.

The Kanban card renders `workspace.name` directly and showed the new name in
every reproduction, including on the commit the reporter's running build came
from.

## Problem statement

Reported behavior after renaming a workspace:

1. The workspace view keeps showing the original label.
2. The Kanban view keeps showing the original name.
3. Opening the rename field again shows the new name, so the write appears to
   have succeeded.

Expected behavior: every surface that identifies a workspace by name shows the
new name as soon as the rename completes.

## How a rename flows today

| Step                 | Code                                                                            | Behavior                                                                              |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Header dialog        | `workspace-header-overflow-menu.tsx:90,108`                                     | Seeds the field from `workspace.name`; submits the rename                             |
| Kanban inline editor | `kanban-card.tsx:472`, `use-inline-workspace-rename.ts`                         | Seeds the field from `workspace.name`; submits the rename                             |
| RPC                  | `workspace.trpc.ts:174`                                                         | Validates and calls the serialized rename use case                                    |
| Persistence          | `workspace-metadata.accessor.ts:64` (`renameAndPin`)                            | Writes `Workspace.name` only; `branchName` is untouched                               |
| Publication          | `workspace-rename.orchestrator.ts:21`, `publishAcceptedName`                    | Emits `snapshot_changed` with source `mutation:workspace_rename`                      |
| Client caches        | `use-project-snapshot-sync.ts`, `workspace-cache-reconciler.ts`                 | Applies the entry to `workspace.listForProject` and `workspace.get`                   |
| Kanban and sidebar   | `kanban-card.tsx:514`, `workspace-item-content.tsx:113`                         | Render `workspace.name`                                                               |
| Workspace header     | `workspace-detail-header.tsx:114-117`, `workspace-detail-header/utils.ts:29-48` | Renders `getWorkspaceHeaderLabel(branchName, name, isMobile)`, which prefers `branch` |

## Investigation

The app was run end to end in Chrome through Playwright, with a real backend, a
real WebSocket, and a temporary SQLite database. The seeded workspace was
`READY`, had a branch, and had no agent session.

| Scenario                             | Current branch (`30b3adbc`) | Reporter's build commit (`eadfcdf3`) |
| ------------------------------------ | --------------------------- | ------------------------------------ |
| `Workspace.name` after rename        | New name                    | New name                             |
| `snapshot_changed` frame received    | New name                    | New name                             |
| Rename field on second open          | New name                    | New name                             |
| Sidebar row                          | New name                    | New name                             |
| **Workspace header after rename**    | **Branch, unchanged**       | **Branch, unchanged**                |
| Kanban card after header rename      | New name                    | New name                             |
| Kanban card after full reload        | New name                    | New name                             |
| Kanban card after inline rename      | New name                    | New name                             |
| Kanban card 75 s after inline rename | New name                    | Not run                              |

The 75-second case spans at least one 60-second snapshot reconciliation pass.
The existing rename tests (34 across the store, orchestrator, router, cache
reconciliation, and header label) also pass, but `getWorkspaceHeaderLabel` tests
assert the branch-preferring behavior, so they protect this defect rather than
catch it.

## Root cause: workspace header

`getWorkspaceHeaderLabel` returns the workspace name only when `branchName` is
empty. Nearly every workspace has a branch, so the rename is invisible there.
Only child workspaces bypass it (`workspace-detail-header.tsx:115-116`).

Two pieces of the codebase already assume the header shows the name:

- `docs/workspaces.md` describes "family navigation beside the workspace name"
  in the workspace header.
- The header dialog's comment says the dialog stays open so it "closes onto" the
  new name (`workspace-header-overflow-menu.tsx:107`).

## Proposed fix: workspace header

Show `workspace.name` as the header label on every viewport, and keep the branch
reachable from the same control.

1. In `workspace-detail-header.tsx`, drop the parent/branch conditional and
   render the workspace name.
2. In `workspace-switcher-dropdown.tsx`, remove the `currentWorkspaceLabel` prop
   and render `currentWorkspaceName`.
3. Add a `currentBranchName` prop and use it for the trigger's `title`, which
   now shows the name redundantly (`workspace-switcher-dropdown.tsx:93`). When
   there is no branch, fall back to the name. This matters because the details
   dialog does not show the branch and **Open branch on GitHub** appears only
   for projects with a GitHub remote.
4. Delete `getWorkspaceHeaderLabel`, its export, and its tests.

No backend, schema, or cache changes are needed.

### Alternatives considered

| Option                                             | Decision                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Always show the name, branch in tooltip (proposed) | Smallest change; matches the Kanban card, sidebar, and child-workspace header                                                          |
| Show the name only after a manual rename           | Rejected. It needs the name's provenance on the client, and the same workspace type would be labelled differently depending on history |
| Show name and branch together in the header        | Rejected for now. The header is already tight at phone widths, and the Kanban card and sidebar already pair the two                    |
| Rename the Git branch along with the workspace     | Rejected. It would affect open PRs, remotes, and running agents to solve a display problem                                             |

### Trade-off

Users who rely on seeing the branch in the header lose it at a glance and must
hover or check the sidebar. Hover is unavailable on touch devices, though the
sidebar row still shows the branch there. If that proves too costly, showing the
branch as a secondary line is a contained follow-up.

## Kanban: open investigation

The Kanban defect is **not reproduced**, and the code path gives no
deterministic cause. The card has no custom memo comparator and no local copy of
the name, and its inline editor seeds from the same value as its title.

The report also constrains the cause. The rename field and the board read from
caches updated by the same snapshot entry. If the field showed the new name, the
client had received it, so a stale card at that same moment would need something
beyond the paths exercised here. The reproductions did not cover workspaces with
active agent sessions or long-lived socket connections.

One simple explanation remains possible: a card shows the name and the unchanged
branch directly beneath it, so the branch line can read as the old label.

To confirm or rule out a real defect, capture the following from an occurrence:

- Whether the rename came from the header or the card, and whether an agent was
  running.
- The card title text compared with the branch line beneath it.
- `Workspace.name` for that row, and whether a reload corrects the card.
- Whether a `/snapshots` frame with source `mutation:workspace_rename` arrived.

### Known weakness, not a confirmed cause

`createWorkspaceRename` discards the result of `publishAcceptedName`
(`workspace-rename.orchestrator.ts:21`). If the store ever rejects a rename
because its name fence is newer, nothing records it. The client would then keep
the stale stream name even over a fresh HTTP response
(`workspace-cache-reconciler.ts:261`), until a later change to that workspace
advances the fence. A rejection needs `updatedAt` values to commit out of order,
and whether that can happen here is unverified. It also would leave the rename
field stale, which contradicts the report.

Logging a warning when an accepted rename is rejected is a cheap way to find out
if this ever occurs. It should ship separately from the header fix, and no
behavior change should follow without evidence.

## Test plan

- `workspace-switcher-dropdown.test.tsx`: the trigger shows the name when a
  branch exists, its `title` shows the branch, and its `title` falls back to the
  name without one.
- Header-level test: after a `workspace.name` change, the label updates while
  `branchName` stays fixed.
- Update `workspace-switcher-dropdown.stories.tsx` for the removed prop.
- Run `e2e/workspace-header.spec.ts` at its phone and desktop widths, since a
  name can be longer than a branch suffix. Regenerate screenshots only if the
  mock header's label changes.
- Manual: rename from the header and confirm the label updates when the dialog
  closes, on desktop and phone widths.

## Rollout

The change is client-only, has no migration, and can be reverted on its own. Add
a changelog entry under Fixed. `docs/workspaces.md` already describes the
intended behavior.
