# Workspace side tables flatten under their original names

Originally decided on 2026-07-26 in #2031, the run-script slice of the split;
the PR, monitoring, discovery and metadata tables follow the same shape.

## Context

Several concerns that had grown on the `Workspace` table (PR facts, PR
monitoring, PR discovery, the run script, the conversation summary) were moved
into 1:1 side tables, each with one writing accessor. Their old column names
were already part of the snapshot wire, the v4 export format and the client.

## Decision

Workspace reads join each side table and flatten its row back onto the workspace
under the field's original name (`runScript*`, `pr*`, `conversationSummary`).
The relation objects never leave the accessor. Moving a concern to its own table
therefore changes no reader.

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
