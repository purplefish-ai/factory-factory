# Workspace State

Several workspace concerns were split out of the `Workspace` table into 1:1 side
tables. They share a shape: one accessor is the sole writer, and reads flatten
the row back onto the workspace under the field's original name, so the snapshot
wire, the v4 export format and the client are unchanged.

Worktree cleanup matches Git's registered paths against the real worktree base
directory, so a symlinked base still removes Git metadata. Branch-resume
validation also resolves the base before checking registered worktrees, so an
already checked-out branch is rejected before creating a workspace. It resolves
the base separately from the worktree so cleanup also works after the worktree
is deleted. If the base symlink itself no longer resolves, cleanup logs a
warning and matches only the exact configured path. Restore the original base
symlink and retry to remove a canonical registration; guessing from a basename
or pruning unrelated registrations could remove another workspace.

A failed workspace that still has a worktree allows queued chat messages to be
resumed without rerunning setup. Its single workspace-level script warning
exposes **Dispatch queued messages** for the selected chat. Ready workspaces
with a setup warning dispatch normally and do not show this action.

Retrying a ready workspace with a setup warning restores READY even when its
setup and startup scripts have been removed, before queued messages dispatch.

Kanban Quick Chat keeps composer attachments in shared chat state, so sending,
rejection recovery, and session restoration use the same attachments as the full
workspace chat.

Git status and base/upstream file lists decode Git's C-quoted paths, including
UTF-8 octal escapes. Renamed status entries use the destination path for
click-to-diff, and upstream filenames retain surrounding spaces.

Unified diff parsing removes the terminating stdout newline before splitting
lines, preserving real blank context lines without fabricating a final row or
line number in the workspace viewer or PR panel.

Workspace terminal reconnects replace each existing tab's output with its server
rolling buffer by terminal ID. Tab identity and selection are preserved; output
outside the server's bounded buffer cannot be recovered.

## Interactive workspace launch

`workspace.create` keeps trusted-local authorization, input validation, and its
workspace response shape. `workspace-launch.orchestrator.ts` coordinates the
interactive MANUAL, RESUME_BRANCH, GITHUB_ISSUE, and LINEAR_ISSUE sources
through narrow capabilities wired by `app-context.ts`; the workspace capsule
still owns source validation and persistence.

For each interactive source, capacity above zero enables effective-provider
resolution and CLI preflight before persistence, followed by best-effort
`followup` / `Chat 1` session provisioning. This gate enables provisioning; it
does not enforce a session limit against an existing workspace. Zero capacity
skips preflight and session provisioning. Session creation failure retains the
workspace and logs a warning. Initialization starts in the background after
provisioning, preserves manual/resume branch options, and logs unexpected
failures without changing the response or deleting the workspace. The same owner
selects separate child and periodic-task policies, described in
[agent runtime](agent-runtime.md#child-workspaces) and
[integrations](integrations.md#periodic-tasks).

## Accepted workspace names

The rename RPC keeps its input validation, not-found response, and persisted
workspace result. Its injected application use case coordinates the existing
persistence writer with snapshot publication. Renames for the same workspace are
serialized within one application; other workspaces remain independent, and
completed or rejected operations release their queue entries.

The snapshot store tracks name freshness independently of unrelated workspace
and lifecycle fields. Accepted renames publish the canonical returned name and
DB `updatedAt`, with equal-millisecond commits ordered by that serialized
writer. Ordinary name observations must be strictly newer. State-change and
reconciliation producers carry canonical DB name provenance, so a delayed older
read cannot overwrite a rename merely because it was observed later. Generic
store callers without provenance retain observation-timestamp ordering.

Name publication changes only an existing live entry and emits the existing
snapshot change synchronously. Missing, removed, ARCHIVING, and ARCHIVED entries
are not recreated. Name updates do not advance other field fences; their private
freshness metadata is not added to full or changed wire payloads. Workspace
persistence remains independent of the snapshot store, and clients retain their
normal stream authority rather than overlaying HTTP names.

## Run script

Startup output accumulates across factory setup and project startup phases. The
first executed phase clears output from prior attempts; subsequent phases
append.

Startup provisioning follows the main shell's exit. Output pipes normally drain
to closure, with a one-second limit after exit so background descendants that
inherit the pipes cannot keep provisioning open. Later output is drained and
discarded until those descendants close their pipes, so writing after
provisioning does not interrupt them. Persistent background commands should
redirect output if it needs to remain available after startup.

The workspace's dev server lives in a 1:1 `WorkspaceRunScript` row (`command`,
`postRunCommand`, `cleanupCommand`, `pid`, `port`, `startedAt`, `status`),
written only by `workspace-run-script.accessor.ts`; reads flatten it back under
the old `runScript*` names.

Two concerns share the row: the three commands are a cache of the worktree's
`factory-factory.json`, the four runtime columns describe a live process. They
share it because they share a writer.

The config group is _not_ derived on read the way the kanban column and
`RatchetState` are — its source of truth is a file, so deriving it would cost a
filesystem call per workspace per list query; `reconcileWorkspaceCommandCache`
repairs drift before a script starts or stops instead.

The runtime group is persisted despite a restart invalidating the process,
because `pid` is the only handle on an orphaned run script (`verifyRunning` uses
`process.kill(pid, 0)`); only `STARTING`/`STOPPING` are cleared at startup.
`registerInitializedWorktree` writes the worktree columns and the commands in
one transaction, since they were one statement before the split.

## Provider defaults

Provider-default updates return `NOT_FOUND` when their workspace was deleted,
including deletion racing the database update, without exposing Prisma error
messages. Other database errors keep their existing handling.

## Backup import

Backup imports require the same trusted local client boundary as project
creation. Project slugs and worktree base paths must be nonempty; legacy backups
with empty values are rejected before any records are imported. Valid backup
paths are preserved rather than recomputed for the current machine.

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

`mode`, `autoIterationStatus`, and compact `autoIteration` travel on the
snapshot wire. The compact projection contains only status, current iteration,
maximum iterations, and the current metric summary. Unknown individual values
remain null, and explicit nulls clear prior progress. Full configuration, test
output, progress, and logbook data remain on their existing detail paths.

The loop fields share their own snapshot timestamp group, independent of
lifecycle and metadata freshness. An accepted reset or newer loop update fences
older reconciliation reads; changing mode invalidates compact hydration until
new compact input is accepted. Default or rejected values never earn the
complete-summary version.

Only `mode` and `config` are exported — `status`, `progress` and `sessionId`
describe a loop that does not survive a backup, so a workspace whose loop was
running when the backup was taken restores idle.

`setStatus`/`setProgress`/`setSession` are unconditional writes that throw on a
missing row (the pre-split path used `prisma.workspace.update`, which threw);
`finishIfSessionMatches` and `clearSessionIfMatches` are compare-and-swaps on
`sessionId`, so a recycled session cannot stamp its outcome over a loop that has
moved on.

`workspaceAutoIterationService` retains `AUTO_ITERATION_STATUS_CHANGED` for
status writes and successful completion compare-and-swaps. Status/progress
writes, successful completion, and guarded startup recovery return mode, status,
config, and progress from the same `updateManyAndReturn` statement. The service
publishes `AUTO_ITERATION_SUMMARY_CHANGED` from those accepted rows using the
shared HTTP/reconciliation projector. Failed writes, missing rows, and missed
compare-and-swaps publish nothing. There is no post-write reread, publication
read token, or existence check: the event describes the accepted write even if
the row has since been changed or deleted. Loop/session authority remains with
the existing workflow and persistence guards.

Startup recovery retains its parallel per-row session/status guards and batch
result ordering. It publishes the accepted rows when the batch completes, then
returns only their IDs. Recovery runs before the startup HTTP/WebSocket command
gate opens and before recurring tasks start; it is not a user-triggered repair
operation. A rejected batch retains its existing rejection behavior, with any
partially landed rows repaired by reconciliation.

The collector immediately flushes compact updates as the sole loop projection
owner; legacy status events remain available to other consumers. Its timestamp
fences a reconciliation pass started before the accepted event. Equal compact
values produce no delta. Creation is currently the only config writer;
reconciliation seeds that configuration, missing entries, and restart state. An
accepted initial progress write publishes the current persisted configuration as
well. Unknown workspaces still await the existing lifecycle membership event or
reconciliation before loop events can update them.

A rejected auto-iteration loop stops its backing session before settling
terminal state. Session teardown is best-effort so a failed stop does not
prevent terminal persistence or removal of the in-memory loop.

Startup sweeps only `RUNNING` to `FAILED` — `PAUSED` is a state the user chose
and the terminal states are results they have not seen.

Auto-iteration treats the root `.factory-factory/` directory as runtime state:
it does not count toward implementation changes and is excluded from iteration
commits and amendments, even when already staged. No-op iterations are recorded
as `crashed` before committing or measuring again, and rejecting code changes
preserves the strategy file for the next iteration. Nested directories with the
same name remain implementation files.

## Kanban model

The UI has a provider-driven intake column (`GitHub Issues` or `Linear Issues`)
plus the columns `WORKING`, `WAITING`, `DONE`.

The column is a projection of `statusReason.code` through
`KANBAN_COLUMN_BY_STATUS_REASON_CODE`
(`src/shared/kanban-column-projection.ts`), derived on every read and never
persisted, so the column a card sits in and the label it shows cannot disagree.
The map is typed as a total `Record` over the code union, so a new reason code
without a column is a compile error. WAITING is positively asserted — it means a
human owns the next action — and a code with no obvious home belongs in WORKING.
Archived workspaces derive no column at all so they stay off the board.

Codex tasks remain automation-owned between turns. An `active` goal keeps the
workspace in WORKING even when no prompt is currently in flight; paused,
blocked, limited, completed and cleared goals do not.

One endpoint (`workspace.listForProject`) serves both the board and the sidebar,
and one React Query cache backs both — the snapshot WebSocket patches that
single cache.

`WorkspaceSummarySchema` defines the required board/sidebar fields independently
of backend and client code. The HTTP list projector retains every legacy list
field, including raw `autoIterationConfig` and `autoIterationProgress`, and adds
a compact `autoIteration` projection. That projection is null for standard
workspaces; for loop workspaces its status, iteration, limit, and metric may be
null when unknown. Configuration input defaults do not turn missing summary
values into iteration zero or a limit of 25; those remain UI presentation
choices. Large configuration, progress, and logbook data are outside the shared
summary contract.

The list still returns `createdAt` as a Date through tRPC. Explicit summary
adapters convert only that field to/from ISO for serialized summaries; session
and last-activity timestamps keep their existing string representation. One
client constructor creates complete optimistic list rows, while detail cache
hydration retains its extra fields and existing initial sidebar status. The
sidebar consumes a required Pick of the same summary instead of an optional
parallel interface. Shared validation schemas do not change the flat snapshot
wire, and existing list/detail hydration fallbacks remain in place.

Snapshot entries may advertise `summaryVersion: 1` once every required summary
input has been accepted from an authoritative read or event. The flat entry
includes issue links, creation source, worktree path, initialization error, and
the compact `autoIteration` object; raw configuration, progress and logbook
remain on legacy/detail paths. A complete claim requires explicit nullable
fields and does not inherit legacy schema defaults. Unversioned entries remain
valid and still use consumer repair.

The store tracks accepted hydration separately from values: a default-shaped
field or a value rejected by a timestamp guard cannot make an entry complete.
Metadata and compact loop state have independent timestamp groups, so a newer
lifecycle transition does not block older unknown metadata from a reconciliation
seed. Mode changes invalidate prior compact-loop hydration; accepted current
mode/status determine its shape and status while known counters are preserved.

Committed lifecycle events publish their row's metadata immediately, including
initial provisioning, READY paths and setup errors. A NEW-only workspace before
initialization gains metadata through reconciliation; no separate creation event
is introduced. Reconciliation seeds metadata, validated compact loop data and
runtime inputs before releasing its seed barrier and starting slow Git work.
Existing incomplete-row repair remains necessary.

Each snapshot WebSocket starts from a full read of current store state after its
optional startup seed wait. Changes emitted before that baseline are already
reflected in the read and are not replayed: an older removal must not override a
workspace restored in the full snapshot. Reading, serializing, sending, and
enabling live deltas run synchronously. Deltas stay suppressed if the full send
fails or the socket closes; a new connection reads a fresh baseline. This
changes no snapshot message shapes.

When a snapshot removes a workspace from that live list, including omission from
a full baseline, the client resets its exact existing detail query. Reset
synchronously clears the old data and cancels its request; active detail views
refetch persisted state, which may be ARCHIVING, ARCHIVED, or not found.
Inactive queries stay empty until opened, and absent queries are not created.
Detail queries have no configured initialData. Repeated removals do not reset a
detail again until a snapshot reintroduces the workspace, so an intentionally
opened archived detail remains usable. Reintroduction cancels the removal fetch
before merging the live summary and refetches active detail, so a late archive
response cannot overwrite an archive rollback. A summary never recreates full
detail.

That endpoint never spawns `git` on its response path: `gitStats` is served from
`workspaceGitStateService`'s cache via `getCachedWorkspaceGitStats`, and a miss
returns null while a background warm recomputes it. Awaiting those recomputes is
what used to hold the board on its loading state — a worktree's stats cost
several `git` spawns and a project with dozens of live workspaces serialized all
of them behind the one query (~20s at 68 worktrees).

`gitStats` is a reconciliation field. Each snapshot poll first seeds all
database and runtime fields, retaining any cached Git stats, then releases the
startup snapshot barrier. A runtime snapshot failure is isolated to its
workspace; healthy workspaces still seed, stale entries are removed, and Git
refresh continues. It recomputes Git stats with bounded concurrency and
publishes each workspace as soon as its Git commands finish; one slow worktree
cannot hold the rest of the board. A failed Git refresh retains a non-null
cached value, while a workspace that no longer has a worktree is explicitly
cleared to null. Git stats have their own optional timestamp group, so the
seed's `lastActivityAt` and the later Git update can carry the same poll-start
timestamp without weakening either field's stale-update protection. The optional
timestamp keeps older snapshot payloads valid during upgrades. A card can be
missing its diff badge for a moment rather than the board being missing
entirely.

Each cache entry watches its worktree and private Git directory, while linked
worktrees share one reference-counted watcher for the repo's common `.git`
directory. Worktree files and private metadata such as `HEAD`, `index`, and
`config.worktree` invalidate only their owning worktree. Common metadata changes
invalidate every dependent entry, including shared config, refs, info attributes
and excludes, and reftable state. Object and reflog writes are ignored because
the associated ref event performs the invalidation. If the shared watcher fails,
all of its dependents switch to the five-minute fallback expiry; removing the
last dependent closes it.

The board provider and its children are keyed by project ID. Switching projects
resets archive recovery and confirmation dialogs, Quick Chat, inline forms, and
the initial mobile tab. Archive results arriving after a switch still reconcile
the originating project cache, but cannot open recovery in the new board, even
when the user has already switched back to the original project.

Inline workspace renames make the editor read-only and busy through the request
and cache refresh. Repeated Enter, clicks, and blur events share one save.
Escape cancels an unsaved edit; after dispatch it closes the editor without
cancelling the request or allowing another save until completion. Failures close
the editor and allow a fresh edit to retry. Workspace/project changes and
departed mounts abandon the editor; late responses reconcile their originating
caches without closing or resetting a newer edit.

Project selection treats only `/projects/new` (with an optional trailing slash)
as the creation route. Deeper routes such as `/projects/new/workspaces` select
and persist the actual project with slug `new`, keeping sidebar, board, and
snapshot synchronization aligned with the URL.

Global Reviews and Settings headers return to the persisted selected project
when it still exists, falling back to the first available project otherwise.

## Completion notifications

Workspace completion notifications count the distinct sessions that worked in
the uninterrupted busy interval ending at the idle transition. Historical idle
sessions do not inflate the count, and repeated turns from one session count
once. The idle event captures the count before the asynchronous workspace
lookup, so a subsequent interval cannot change an earlier notification. Lookups
and notification requests run in idle order per workspace; a failed lookup does
not block later intervals, and separate workspaces can proceed independently.

Archiving or deleting a workspace suppresses completion notifications throughout
runtime shutdown, worktree cleanup, persistence, and archive rollback. Late
prompt callbacks cannot lift suppression; overlapping cleanup operations keep it
active until both finish. Activity created during cleanup is invalidated before
normal notifications resume. Persisted ARCHIVING/ARCHIVED workspaces and deleted
rows also suppress late notifications after cleanup has ended. Other workspace
caches are cleared only after the archive or deletion succeeds. Restarted
activity gets a new state, so an older lookup cannot notify for that earlier
lifecycle. Clearing also detaches the old notification chain, so restarted work
does not wait for an earlier lookup.

## PR monitoring status

PR monitoring queues updates in its bound ordinary conversation. Enablement,
recipient, pause and pending-event count come from `WorkspacePRMonitoring` and
`WorkspacePREvent`; live agent work comes from session runtime state. Idle
failed CI, a queued update or a paused delivery does not create a working agent
signal. An attached open PR keeps the workspace actionable when a sibling
merges. See [PR update delivery and recovery](pull-requests.md).
