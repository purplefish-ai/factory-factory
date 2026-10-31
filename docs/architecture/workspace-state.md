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

While chat session history loads, workspace initialization takes priority in the
chat loading indicator. It shows one spinner with the setup status, then falls
back to the session loading status if history is still loading after setup.

Workspace initialization finishes both factory setup and project startup scripts
and persists READY before starting the default agent session. Provider startup
hooks can depend on installed tools and generated files, so setup does not run
inside the agent's startup timeout. Initial task preparation runs alongside
provisioning, so issue lookups do not delay worktree creation or setup. The task
is published as soon as it is ready, before READY, and remains cancellable
during setup. Inactive disconnect cleanup retains the queue only while the
initial task is undelivered. It resets hydrated history and runtime state while
retaining unexpired recent rejections and terminal PR outcomes. Provisioning
retries preserve cancellation within the running server. Non-fatal script
failures still persist READY with a warning before the agent starts; unexpected
provisioning failures do not start an agent or publish a late prompt.

Retrying a ready workspace with a setup warning restores READY even when its
setup and startup scripts have been removed, before queued messages dispatch. A
ready workspace whose worktree is missing is blocked with a retry action;
retrying moves it to PROVISIONING and reruns full initialization to recreate the
worktree.

Kanban Quick Chat keeps composer attachments in shared chat state, so sending,
rejection recovery, and session restoration use the same attachments as the full
workspace chat.

Workspace creation and new-conversation controls share a compact provider/model
picker. Each launch starts from saved provider-specific defaults; changing an
active conversation does not copy its model into a new conversation. Explicit
launch choices survive settings refreshes. The new-conversation menu nests
models under each provider; selecting a model applies its provider and model
together. Clicking a provider name (or pressing Enter) selects its saved default
model, including when that provider is already selected. Hover, the row's arrow,
or Right Arrow opens its models without changing the draft. Workspace/provider
inheritance still applies when no explicit provider is selected.

The sidebar creation form keeps provider/model and thinking settings above a
compact action row with attachments, workspace settings, Cancel and Launch.
Workspace settings groups account selection, access, Plan and PR updates in a
labeled popover. Its trigger marks active options and warns about unsupported
selections after discovery completes. Access warnings include an icon and text;
closing settings preserves the launch draft. Escape inside settings closes the
popover without cancelling workspace creation.

The tab bar's **New** selection configures a new conversation. The composer's
picker shows the current conversation's provider and changes only its model;
switching providers requires a new conversation. Model controls remain visible
through configuration loading and partial ACP updates, with temporary disabled
states explained instead of silently hiding the control.

Git status and base/upstream file lists decode Git's C-quoted paths, including
UTF-8 octal escapes. Renamed status entries use the destination path for
click-to-diff, and upstream filenames retain surrounding spaces.

Unified diff parsing removes the terminating stdout newline before splitting
lines, preserving real blank context lines without fabricating a final row or
line number in the workspace viewer or PR panel.

Workspace terminal reconnects replace each existing tab's output with its server
rolling buffer by terminal ID. Tab identity and selection are preserved; output
outside the server's bounded buffer cannot be recovered.

Terminal CPU and memory usage is sampled only when the admin processes view asks
for it, with one batched `pidusage` call; there is no background polling. If the
batch fails (for example because a process exited), each terminal is sampled
separately and in parallel, and terminals that cannot be read show no usage.

## Interactive workspace launch

`workspace.create` keeps trusted-local authorization, input validation, and its
workspace response shape. `workspace-launch.orchestrator.ts` coordinates the
interactive MANUAL, RESUME_BRANCH, GITHUB_ISSUE, and LINEAR_ISSUE sources
through narrow capabilities wired by `app-context.ts`; the workspace capsule
still owns source validation and persistence. Every creation source requires an
active project in the atomic workspace insert; archiving a project after a
preflight read still prevents the workspace and its side tables from being
created. Creation reports archived-project failures as `PRECONDITION_FAILED` and
missing projects as `NOT_FOUND`, including when the guarded insert loses a race
after validation. Other persistence failures retain their existing handling.

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

## Accepted workspace branches

Manual successful branch renames resolve canonical Git HEAD before writing;
automatic renames write only after their Git rename succeeds. Both use the
workspace data service's branch acceptance gateway. Its transaction returns the
canonical branch, status, and DB `updatedAt` only after the branch update and PR
discovery schedule reset commit together. Failed transactions emit no fact.
Subscriber failures are logged after commit without failing the rename or
interrupting remaining synchronous subscribers; reconciliation repairs missed
cache publication. The gateway serializes persistence through synchronous
accepted-event delivery per workspace; other workspaces remain independent and
failures release the queue. The collector subscribes for its own start/stop
lifetime and immediately publishes accepted branches, bypassing observation
coalescing.

The store tracks branch freshness privately, independently of workspace,
lifecycle, and name clocks. Equal DB milliseconds are accepted only from the
serialized branch writer. Lifecycle and reconciliation observations carry the
row's DB timestamp and must be strictly newer; stale reads cannot undo a rename
or produce branch drift diagnostics. Accepted branches hydrate only branchName,
which is still required for a complete summary. An unchanged branch can advance
freshness without emitting a new version. Missing, removed, archiving, and
archived entries cannot be seeded by acceptance, including when the returned
canonical row is already archiving or archived. Removal clears private branch
freshness; provenance never enters the wire payload.

Periodic reconciliation still repairs missed events and restart state. Its
60-second interval is the delay after a completed run, not a hard maximum for
stale UI: prior Git work, the next database read, and failed sweeps can delay
repair. A pass removes only entries absent from its database read that have no
observation at or after the pass's start, so a workspace created while the read
is in flight survives until a later pass can see it.

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

Run-script output subscribers, such as the dev-logs socket, persist across
stops, exits, and restarts until they unsubscribe or the workspace is archived
or deleted. The postRun command is spawned only if its run script is still
active after tunnel startup, neither exited nor being stopped, because stop and
exit cleanup would not see a postRun spawned later.

## Provider defaults

Provider-default updates return `NOT_FOUND` when their workspace was deleted,
including deletion racing the database update, without exposing Prisma error
messages. Other database errors keep their existing handling.

## Backup import

Backup imports require the same trusted local client boundary as project
creation. Project slugs and worktree base paths must be nonempty; legacy backups
with empty values are rejected before any records are imported. Valid backup
paths are preserved rather than recomputed for the current machine.

## Retired auto-iteration

Auto-iteration is removed. Workspaces, conversations, worktrees, branches, and
commits created through that feature remain ordinary workspace data. Its loop
runtime, configuration/progress side table, snapshot fields, permissions
setting, and launch controls are gone. No loop is resumed or finalized on
startup. Older backups are normalized at import by discarding the retired
fields; normal workspace and session data remain available. Existing on-disk
insight/logbook files are user workspace files and are not deleted by the
application migration.

## Kanban model

The UI has a provider-driven intake column (`GitHub Issues` or `Linear Issues`)
plus the columns `WORKING`, `WAITING`, `DONE`.

The workspace switcher groups workspaces under Working, Waiting, and Done in
board order. All WAITING workspaces share one group regardless of pending
request type; Todo is reserved for the board's issue intake column.

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

Navigation, the board, and the workspace switcher use
`useProjectWorkspaceQuery`, which retains the tRPC query key and installs the
project-list reconciler at React Query's synchronous cache commit. Before the
current connection's full baseline, HTTP owns membership and live fields.
Afterward, HTTP can hydrate metadata omitted by snapshots but cannot restore
removed rows or overwrite newer live fields or a supplied stream review count.
The reconciler consumes each HTTP response's identity tag once, so explicit
optimistic mutation writes retain their existing behavior.

Reconciliation ownership is scoped to the QueryClient, project, and connection
lifetime. Disconnecting or leaving a project retires that token, cancels its
pending list and detail HTTP requests, and invalidates them for HTTP fallback.
Only detail queries with known project ownership are cancelled for that project.
Unassociated initial details keep loading independently; if their HTTP response
reveals a retired project generation, its cache commit is rejected and the same
active query retries under the current generation. Each post-retirement
connection starts a fresh epoch and restarts pending fallback requests; the very
first connection still accepts its initial HTTP bootstrap. The next full
establishes fresh stream authority without comparing versions across server
lifetimes. The transport rejects events from replaced physical sockets; the
snapshot hook also rejects callbacks from retired project activations. Legacy
unknown-workspace and READY worktree-path list repairs continue through the same
query options. Valid complete version-1 summaries seed their canonical metadata
immediately and skip those two repairs, including when an authoritative worktree
path is null. Reconnect invalidation and detail hydration remain in place.

Both workspace archive callers use `useWorkspaceArchiveCommand` for single and
column archive mutations. Each command captures its project and IDs, and the
project reconciler assigns its optimistic removal an operation ID. Pending IDs
stay hidden after accepted stream or HTTP commits, including reconnects. Only
pending IDs retain rollback candidates; each accepted base updates those
candidates, and authoritative removal deletes them. Failure releases only its
own overlay and restores eligible failed IDs from that latest base, preserving
unrelated updates and overlapping operations. A successful overlapping archive
cannot be undone by another command's failure or a later accepted base while
that overlap remains pending. The per-ID success fence ends with the last
overlapping operation; later authoritative introductions remain eligible. Extra
server-selected bulk successes participate in that same settlement. Repair
failures never change the archive's per-workspace outcome. Each HTTP attempt
also captures a settlement generation and its originating query/request.
Settlement rotates that generation before releasing overlays; an older
continuation cancels instead of dispatching success over a newer fetch. Scoped
recovery retries a mounted bootstrap without undefined success or a stuck load.
Fresh requests started after settlement keep normal membership authority.

Within one server process, requests for the same workspace share an in-progress
archive's result, including overlapping single and column archives. Cleanup runs
once; waiting requests receive the same success or cleanup failure. When an
ordinary archive is already in flight, an explicit Git index-lock removal
request waits and retries with its recovery option only if that archive fails
with an index-lock error. With no archive in flight, recovery runs immediately.

Already archived workspaces are accepted quietly. An archiving snapshot with no
local pending operation is re-read so a rolled-back archive can be retried. A
known local failed rollback resumes cleanup on the next request. Other archiving
rows are acknowledged immediately without taking over another process's cleanup,
waiting for it, or observing its eventual result. Age alone does not establish
ownership; abandoned archives from a prior process remain subject to startup
recovery. Requests that lose the conditional state transition re-read the
workspace and retry once if it has rolled back to an archivable state. Other
invalid transitions and cleanup failures remain errors.

The board keeps issue intake suppressed per pending operation and owns locked
subset recovery, retries and selection. The detail route owns its dialogs and
post-success navigation; leaving its committed workspace lifetime suppresses
late navigation and dialog callbacks. The server broadcasts ARCHIVING before the
archive work finishes, so the route's ARCHIVING/ARCHIVED redirect waits while
its own archive is pending; lock recovery stays reachable, and archives started
elsewhere still redirect immediately. IDE commands live separately in
`useWorkspaceIdeActions` and have no archive cache policy.

The route and right panel share `useWorkspaceDetailQuery` and the existing
`workspace.get` key. At HTTP success commit, accepted snapshots from that same
connection overlay live fields on the fetched detail; initialization metadata,
provider selection, agent and terminal records remain HTTP-owned. Creation seeds
install compatible cache options and preserve an existing detail. Compact
summaries never seed a full fetched detail, so missing details keep loading
until HTTP returns. Detail response tags are consumed once, preserving
deliberate optimistic writes and unchanged nested references and dates. Detail
owners are released with QueryCache removal/garbage collection. Reusable query
options select the current owner when fetching; weak response provenance still
routes each HTTP commit to its originating owner. Every request receives a
unique shallow result identity, preserving nested objects and dates even when a
fetcher returns the same immutable object again. Creation seeds build compatible
queries without retaining per-workspace query defaults. Deferred recovery checks
the same query and owner identity, preserves a fresh active cache write, and
settles inactive queries without starting more HTTP.

Live-list removal still resets the exact detail query and cancels its in-flight
request before active observers refetch persisted detail. Reintroduction cancels
that removal fetch and refetches missing full detail. Repeated removal messages
do not erase deliberately reopened archived detail. Initialization retains
`getInitStatus` polling and readiness/worktree-path invalidations; those repairs
hydrate omitted metadata through the shared detail options.

`WorkspaceSummarySchema` defines the required board/sidebar fields independently
of backend and client code. The HTTP list projector and snapshot summaries share
that contract. Retired loop configuration and progress are absent from list,
detail, and snapshot projections.

The list still returns `createdAt` as a Date through tRPC. Explicit summary
adapters convert only that field to/from ISO for serialized summaries; session
and last-activity timestamps keep their existing string representation. One
client constructor creates complete optimistic list rows, while detail cache
hydration retains its extra fields and existing initial sidebar status. The
sidebar consumes a required Pick of the same summary instead of an optional
parallel interface. Shared validation schemas do not change the flat snapshot
wire, and legacy list/detail hydration fallbacks remain in place.

Snapshot entries may advertise `summaryVersion: 1` once every required summary
input has been accepted from an authoritative read or event. The flat entry
includes issue links, creation source, worktree path, and initialization error.
A complete claim requires explicit nullable fields and does not inherit legacy
schema defaults. Unversioned entries remain valid and still use consumer repair.

The store tracks accepted hydration separately from values: a default-shaped
field or a value rejected by a timestamp guard cannot make an entry complete.
Metadata has an independent timestamp group, so a newer lifecycle transition
does not block older unknown metadata from a reconciliation seed.

The workspace capsule's pure `workspace-read-state` helpers own last-activity
selection and normalized derived-state inputs for project lists, child reads,
workspace details, and snapshot re-derivation. The activity helper returns the
selected timestamp as an ISO string or null; callers retain runtime reads and
all other date and transport policy. The store derives only after timestamp
merges, using its private raw session-busy value; active ratchet state does not
itself make `isWorking` true.

The creation service synchronously publishes `WORKSPACE_CREATED` on the shared
workspace lifecycle event owner immediately after the database commit, before
session provisioning or initialization waits. The collector projects the
committed row's metadata and DB name/branch provenance directly into a missing
snapshot entry. NEW derives to Working, so streamed creation appears in the
sidebar while required session setup is pending. A creation fact cannot replace
an existing entry, bypass a current removal tombstone, or seed
ARCHIVING/ARCHIVED input. Subscriber failures are logged individually and do not
fail persisted creation or block later subscribers. Collector stop detaches this
subscription.

Committed state-change events also publish their row's metadata immediately,
including initial provisioning, READY paths and setup errors. Lifecycle updates
and reconciliation keep their usual authority. Creation alone does not claim a
complete summary; legacy HTTP metadata repair remains available. Reconciliation
seeds metadata and runtime inputs before releasing its seed barrier and starting
slow Git work. The client validates a complete claim before adopting the
canonical flat summary. Complete metadata values, including explicit nulls,
replace old list values. Legacy entries preserve HTTP metadata repair and retry.
Malformed version claims fail wire validation. Board and navigation consumers
use the shared summary type. Complete summaries still never create fetched full
detail, and detail-only initialization fields remain HTTP-owned. Existing
incomplete-row repair remains necessary.

`workspace-detail-snapshot-transitions` owns snapshot departure discovery, exact
detail resets, and live detail merging. Each snapshot hook mount retains one
opaque transition scope across reconnects, project switches, QueryClient
replacement, and StrictMode effect replay. An actual remount gets fresh removal
history; independent mounts do not share it. Binding the scope to a project and
QueryClient selects its cache operations without changing that history. HTTP
detail owners still follow each Query's cache removal/GC lifetime and own
response provenance and success-commit guards.

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
