# Workspace side tables flatten under their original names

Originally decided on 2026-07-26 in #2031, the run-script slice of the split;
the PR, monitoring, discovery and metadata tables follow the same shape.

## Context

Several concerns that had grown on the `Workspace` table (PR facts and PR
discovery, the ratchet columns that became PR monitoring, the run script) were
moved into side tables: 1:1 rows, except `WorkspacePR`, which became a
collection of associations. After creation each table has one writing accessor.
Their old column names were already part of the snapshot wire, the v4 export
format and the client. The conversation summary was never a `Workspace` column:
it was added as a new side table, `WorkspaceMetadata` (#2752).

## Decision

The workspace accessor's full reads join each side table and flatten its row
(for PRs, the selected association and the collection summary) back onto the
workspace under the field's original name (`runScript*`, `pr*`, `ratchet*`), and
`WorkspaceMetadata` the same way as `conversationSummary`; narrower
purpose-built reads select only what they need. The relation objects never leave
the accessor. Moving a concern to its own table therefore changes no reader.

Rejected: renaming the fields to match the new tables, which would have changed
the snapshot wire, every export reader and the client in the same change.

## Consequences

- The snapshot wire aliases and the v4 export format stayed compatible.
- A write to a side table does not touch `Workspace.updatedAt`, because
  `@updatedAt` fires only for the table written; starting or stopping a run
  script no longer moves its workspace up lists ordered by `updatedAt`.
- PR reads keep the old flat fields for compatibility, with mixed sources (the
  selected association for some, the collection summary for others), so new
  consumers read `selectedPr` and `prSummary` instead.
