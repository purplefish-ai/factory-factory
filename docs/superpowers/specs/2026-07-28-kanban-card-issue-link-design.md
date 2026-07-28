# Kanban Card Issue Link Design

## Goal

Show the originating ticket on a workspace's Kanban task card when the workspace was created from a GitHub or Linear issue.

## User Experience

The card metadata includes a compact issue link:

- GitHub issues use the existing `#<number>` label, such as `#1905`.
- Linear issues use the existing identifier, such as `ENG-1905`.
- Selecting the link opens the stored issue URL in a new browser tab.
- Selecting the link does not navigate to the workspace or trigger the card action.
- A workspace without a linked issue is unchanged.

The issue row uses the same small, muted metadata treatment as the card's branch and pull-request rows.

## Architecture

The shared project workspace payload already supplies `githubIssueNumber`, `githubIssueUrl`, `linearIssueIdentifier`, and `linearIssueUrl`, so no backend, database, schema, or data-fetching changes are needed.

`src/client/features/kanban/kanban-card.tsx` will derive an issue label and URL from those fields, preferring a complete Linear link when present and otherwise using a complete GitHub link. A focused card-local row component will render the link. The card's metadata visibility calculation will include the issue row so a linked issue appears even when it is the card's only metadata.

The implementation remains local to the Kanban feature because the sidebar's issue presentation has a different layout and interaction contract; extracting a shared component would add coupling without removing meaningful duplication.

## Interaction and Error Handling

The issue link will prevent the card's default navigation and stop event propagation before opening the issue URL with `noopener,noreferrer`. Incomplete issue data, such as an identifier without a URL, will not produce a nonfunctional link.

## Testing

Focused `KanbanCard` tests will verify:

- A GitHub-backed workspace renders its `#<number>` label and opens the GitHub issue URL.
- A Linear-backed workspace renders its identifier and opens the Linear issue URL.
- Clicking the issue link does not navigate through the enclosing workspace card.
- The issue link creates card metadata when no other metadata is present.

The existing project checks and type checking will guard formatting, dependency boundaries, and TypeScript correctness.
