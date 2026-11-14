# Workspace State

This note has moved. Ownership, public surface, invariants and maps are in the
guides beside the code:

- [Workspace capsule](../../src/backend/services/workspace/AGENTS.md) and its
  [snapshot store](../../src/backend/services/workspace/service/snapshot/AGENTS.md).
- [Workspace lifecycle orchestration](../../src/backend/orchestration/workspace-lifecycle/AGENTS.md):
  launch, initialization and retry, archive, startup recovery.
- [Snapshot orchestration](../../src/backend/orchestration/snapshots/AGENTS.md):
  the event collector and periodic reconciliation.
- [Run-script capsule](../../src/backend/services/run-script/AGENTS.md) and
  [data backup](../../src/backend/orchestration/data-backup/AGENTS.md).
- [Kanban feature](../../src/client/features/kanban/AGENTS.md) and the
  [client workspace query cache](../../src/client/lib/AGENTS.md).
- [Backend services](../../src/backend/services/AGENTS.md): blob columns on hot
  reads.

The reasons are in the `2026-11-13-*` records in [decisions](../decisions/), and
the tests those guides name describe the behaviour.

This page remains as long as links from other documents point here or the
section below still holds entries; delete it when both are gone.

## Held for other guides

Rules, hazards and reasons from the old note that belong to another area. Each
entry quotes only the sentences it needs from the paragraph named after it,
verbatim, with `[…]` where sentences between them are left out. The migration
that creates the named area's guide checks the entry, moves what holds there and
deletes the entry here. Paragraph numbers are the rows of the disposition tables
in pull requests #3229 (first half) and #3239 (second half).

> CI and sidebar status helpers and types have one internal import surface:
> `@/shared/core`. Their dependency-free implementations live in
> `src/shared/core/`; sibling core modules may import those files directly.
> These source paths are internal application code, not supported package
> imports. The published package exposes the `ff` CLI, not a shared-status SDK.

Old paragraph 1 (#3229). For a dependency rule for `src/shared/core/` (task
2.10). No rule enforces it, and 25 files outside import `enums.ts` directly
today.

> Claude's structured-output schema uses JSON Schema Draft 7 for runtime
> compatibility.

Old paragraph 5 (#3229). For the session capsule guide.

> Agent sessions are not covered.

Old paragraph 39 (#3229), after "Terminals and setup, run, postRun and cleanup
scripts run the user's commands, so they omit the variables Factory Factory's
launchers set for its own backend". For the session capsule guide.

> Changes emitted before that baseline are already reflected in the read and are
> not replayed: an older removal must not override a workspace restored in the
> full snapshot.

Old paragraph 35 (#3239), after "Each snapshot WebSocket starts from a full read
of current store state". For the WebSocket router guide
(`src/backend/routers/websocket/`, task 2.9).
