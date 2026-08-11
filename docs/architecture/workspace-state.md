# Workspace State

Several workspace concerns were split out of the `Workspace` table into 1:1 side
tables. They share a shape: one accessor is the sole writer, and reads flatten
the row back onto the workspace under the field's original name, so the snapshot
wire, the v4 export format and the client are unchanged.

## Run script

The workspace's dev server lives in a 1:1 `WorkspaceRunScript` row (`command`,
`postRunCommand`, `cleanupCommand`, `pid`, `port`, `startedAt`, `status`),
written only by `workspace-run-script.accessor.ts`; reads flatten it back under
the old `runScript*` names.

Two concerns share the row: the three commands are a cache of the worktree's
`factory-factory.json`, the four runtime columns describe a live process. They
share it because they share a writer.

The config group is *not* derived on read the way the kanban column and
`RatchetState` are — its source of truth is a file, so deriving it would cost a
filesystem call per workspace per list query; `reconcileWorkspaceCommandCache`
repairs drift before a script starts or stops instead.

The runtime group is persisted despite a restart invalidating the process,
because `pid` is the only handle on an orphaned run script (`verifyRunning` uses
`process.kill(pid, 0)`); only `STARTING`/`STOPPING` are cleared at startup.
`registerInitializedWorktree` writes the worktree columns and the commands in
one transaction, since they were one statement before the split.

## Auto-iteration state

The loop's five fields live in a 1:1 `WorkspaceAutoIteration` row (`mode`,
`status`, `config`, `progress`, `sessionId`), written only by
`workspace-auto-iteration.accessor.ts`; reads flatten it back under the old
`mode`/`autoIteration*` names.

`mode` travels with the group rather than staying on `Workspace`: it reads like
a general workspace attribute, but every consumer is an auto-iteration consumer
(the kanban badge, the right panel, the progress banner, creation validation,
and the `auto-iteration.trpc.ts` entry guard), so it is the group's discriminant
— the same call the ratchet split made for `ratchetEnabled`.

`mode` and `autoIterationStatus` are on the snapshot wire, because the status
reason derives `AUTO_ITERATING` from them and the snapshot store has to reach
the same answer as the query path, but only `mode` moved to the client's
`projectSnapshotToLiveFields`. `autoIterationStatus` remains in the client's
`mutationOnlyFieldDefaults` alongside `config`, `progress` and `sessionId`
(`src/client/lib/snapshot-to-workspace.ts:21`) — the client's own kanban badge
reads the mutation-cached value directly rather than through `statusReason`, so
it does not need a live-updated copy.

Only `mode` and `config` are exported — `status`, `progress` and `sessionId`
describe a loop that does not survive a backup, so a workspace whose loop was
running when the backup was taken restores idle.

`setStatus`/`setProgress`/`setSession` are unconditional writes that throw on a
missing row (the pre-split path used `prisma.workspace.update`, which threw);
`finishIfSessionMatches` and `clearSessionIfMatches` are compare-and-swaps on
`sessionId`, so a recycled session cannot stamp its outcome over a loop that has
moved on.

`workspaceAutoIterationService` is an `EventEmitter`: it announces
`AUTO_ITERATION_STATUS_CHANGED` from `setStatus` and from a
`finishSessionIfMatching` that actually settled, and the event collector
enqueues the pair. Without that event the snapshot store learned about a
transition only from the reconciliation sweep, so for up to one sweep interval
the live stream re-derived every card from a stale status and a running loop
read as waiting between iterations. The event carries `mode` as well as `status`
— the store's copy of `mode` is otherwise seeded only by reconciliation, so a
loop reaching a gap inside that window would be derived against a `STANDARD` it
never had. The two status writes report the row they landed on (`{ mode, status
}`, and `{ settled, mode }` for the compare-and-swap) so the service never
infers the mode from the fact that an auto-iteration code path is running.

Startup sweeps only `RUNNING` to `FAILED` — `PAUSED` is a state the user chose
and the terminal states are results they have not seen.

## Kanban model

The UI has a provider-driven intake column (`GitHub Issues` or `Linear Issues`)
plus the columns `WORKING`, `WAITING`, `DONE`.

The column is a projection of `statusReason.code` through
`KANBAN_COLUMN_BY_STATUS_REASON_CODE` (`src/shared/kanban-column-projection.ts`),
derived on every read and never persisted, so the column a card sits in and the
label it shows cannot disagree. The map is typed as a total `Record` over the
code union, so a new reason code without a column is a compile error. WAITING is
positively asserted — it means a human owns the next action — and a code with no
obvious home belongs in WORKING. Archived workspaces derive no column at all so
they stay off the board.

One endpoint (`workspace.listForProject`) serves both the board and the sidebar,
and one React Query cache backs both — the snapshot WebSocket patches that
single cache.

That endpoint never spawns `git` on its response path: `gitStats` is served from
`workspaceGitStateService`'s cache via `getCachedWorkspaceGitStats`, and a miss
returns null while a background warm recomputes it. Awaiting those recomputes is
what used to hold the board on its loading state — a worktree's stats cost
several `git` spawns and a project with dozens of live workspaces serialized all
of them behind the one query (~20s at 68 worktrees). `gitStats` is a
reconciliation field, so the snapshot poll recomputes it for every live
workspace each minute and streams it into the same cache; a card is missing its
diff badge for a moment rather than the board being missing entirely.

Note that each worktree's cache entry is watched via the repo's *shared* `.git`
common dir, so git activity in any one worktree invalidates the others' entries
— the cache is cold more often than a per-worktree watcher would suggest, which
is exactly why the response path must not depend on it being warm.
