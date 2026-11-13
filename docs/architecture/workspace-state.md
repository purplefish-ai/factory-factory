# Workspace State

The sections that preceded "Kanban model" have moved. Ownership, public surface,
invariants and file maps are in the guides beside the code:
[workspace capsule](../../src/backend/services/workspace/AGENTS.md),
[workspace lifecycle orchestration](../../src/backend/orchestration/workspace-lifecycle/AGENTS.md),
[run-script capsule](../../src/backend/services/run-script/AGENTS.md) and
[data backup](../../src/backend/orchestration/data-backup/AGENTS.md). The
reasons are in the `2026-11-13-*` records in [decisions](../decisions/), and the
tests those guides name describe the behaviour. The sections below have not been
migrated yet.

<a id="backup-export"></a>Links here with this anchor were for backup export:
the [data backup guide](../../src/backend/orchestration/data-backup/AGENTS.md),
and for archived rows
`src/backend/orchestration/data-backup/archived-workspace-blobs-backup.integration.test.ts`.

## Kanban model

On mobile, successful task creation closes the inline form, clears the filter
and reveals Working. The newly created workspace is already cached and sorted
first; the board scrolls so its setup card is visible immediately. Cancelling or
failing creation does not reveal Working. Desktop keeps all columns visible and
closes the form on success.

The UI has a provider-driven intake column (`GitHub Issues` or `Linear Issues`)
plus the columns `WORKING`, `WAITING`, `DONE`.

Card titles wrap within two lines, including names with long unbroken words. The
header reserves space for its actions so they stay inside the card at narrow
column widths.

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

A merged or closed PR places an idle workspace in Done when at least one
attached terminal PR is undismissed and no attached PR is nonterminal, including
an unsynced `NONE` association. Accepting a human follow-up dismisses existing
terminal PRs from completion across all workspace conversations. The PRs remain
attached and visible as history. The workspace uses Working while the agent runs
and Waiting (Ready for next prompt) once idle; pending user requests still take
precedence. New PRs participate in completion normally, and observing a PR
reopen resets its dismissal. A change from closed to merged also starts a new
completion, even if polling missed the intervening reopen. Repeated observations
of the same terminal state preserve the dismissal. It persists across restarts
and backups; older backups default to undismissed PRs.

Only accepted human input dismisses completion, including messages such as
"thanks". Rejected messages, transcript replay, background PR updates, and
simply starting a session do not. Queue admission persists the change before
dispatch and publishes the updated PR collection to the board and sidebar. An
admission write cannot dismiss a first terminal observation made after that
input was accepted. A merge first discovered after the follow-up still counts as
new completion; reopening follows the PR facts already known to the application.
Routine polling preserves the first terminal observation time so it cannot
interfere with a follow-up already being admitted. Queued messages remain held
from dispatch and steering until the follow-up persistence completes.
Cancellation waits for admission to settle so Accepted precedes Cancelled.
Direct input preserves arrival order through admission, rechecks stop guards
before submission, and returns unsent text and images through composer recovery
when admission fails or a later provider submission fails. Recovery replies
return only to the requesting connection. Persisted PR revisions fence older
event and reconciliation projections; an archive during a follow-up read still
wins publication.

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

`src/client/lib/workspace-queries.ts` is the only place that builds options,
fetches or writes for `workspace.get` and `workspace.listForProject`. React
Query lets the latest fetch or observer of a key replace that key's options,
including the commit hook, so a plain tRPC `useQuery`, `fetch` or `setData` on
either key would commit untagged HTTP data over live fields and leave later
invalidation refetches unreconciled. Readers use `useProjectWorkspaceQuery`
(observer-only `staleTime`), `useWorkspaceDetailQuery` (observer-only `enabled`,
`refetchInterval` and `staleTime`), `fetchWorkspaceDetail` or
`ensureWorkspaceDetail`; optimistic list rows, creation seeds and stream detail
merges use the module's writers. Invalidation, cancellation and cache reads keep
using tRPC utilities because they reuse the options already installed.
Operations that would otherwise need a raw QueryClient key are module functions
instead: `resetWorkspaceDetail`, `invalidateWorkspaceDetail`,
`cancelWorkspaceDetail`, `refetchActiveWorkspaceDetail`,
`getCachedWorkspaceDetails` and `cancelProjectWorkspaceList`. Query options
still carry their key for `useQuery`; never pass it to a raw QueryClient fetch
or write.

The `factory/query-owner` lint rule rejects tRPC `useQuery`, `fetch`,
`ensureData`, `prefetch`, `setData` and related helpers, plus `getQueryKey`, for
either procedure outside the module and the reconciler (the `owners` of its
workspace group in `.oxlintrc.json`); tests are exempt. The reconciler relies on
three React Query behaviours. First, it calls a function `structuralSharing`
synchronously at the commit. Second, a thrown `CancelledError({ revert: true })`
commits nothing and sets no error state: a refetch resolves with the previous
data, while an initial fetch rejects and stays `pending`. Third, the latest
fetch or observer of a key installs the options that later option-less refetches
and writes use. `query-core-commit-contract.test.ts` pins each case so a React
Query upgrade fails loudly instead of disabling reconciliation.

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

Archive and delete stop the workspace's sessions, run script and terminals
first; any failure there aborts the operation. After they succeed and before the
worktree is removed, a best-effort sweep terminates leftover processes such as a
dev server an agent detached from a background shell. A process matches only if
it belongs to the server's user, has no controlling terminal, is not the server,
one of its ancestors or PID 0/1, and has its working directory or executable on
a path boundary inside the worktree. Both the configured and realpath-resolved
worktree paths are checked, and each must be strictly inside the matching
project worktree base. Command-line arguments are never matched, so a process
that only names the worktree in its arguments, such as an editor opened on it,
is left alone. Matches receive SIGTERM. After three seconds the processes are
listed again, and survivors that still match with the same start time receive
SIGKILL; a PID reused in the meantime is not killed. Each listing is bounded to
four seconds. macOS uses `ps` and `lsof`, Linux reads `/proc`, and other
platforms skip the sweep. A sweep failure is logged and never blocks the archive
or delete; a sweep that fails partway may already have stopped some processes
and left others running. Workspaces archived before this sweep existed keep
their leftover processes until they exit or are stopped by hand.

Once a workspace is durably ARCHIVED, archive releases data that only Retry
setup needed. `initialAttachments` is removed from `creationMetadata`; the
initial prompt and every other key stay, and SQL NULL stays NULL. `initOutput`
keeps a 4,096-character tail, marked as truncated, when `initErrorMessage` is
set (a failed or warned setup) and is cleared otherwise. The rewrite runs in SQL
and re-checks ARCHIVED, so an ARCHIVING workspace, which can roll back, keeps
everything; it leaves `updatedAt` alone. A failed release is logged and does not
affect the archive. The `archived-workspace-blob-retention` job
([background jobs](background-jobs.md#archived-workspace-data)) releases rows
archived before this existed, rows a failed release missed and archived rows
restored from older backups ([backup export](#backup-export)). The Setup logs
tab says the log is not kept for an archived workspace, and labels a kept tail.

Startup archive recovery runs in the background after essential session and
workspace state repairs. Slow Git worktree cleanup does not delay HTTP/WebSocket
readiness or the CLI startup signal; affected workspaces remain ARCHIVING until
recovery completes or marks them FAILED. Shutdown drains that recovery before
closing its session, run-script, cache, and database dependencies. If shutdown
begins during essential reconciliation, startup aborts before launching archive
recovery or starting background services.

Startup reconciliation repairs stale PROVISIONING workspaces before readiness,
marking them FAILED unless their tracked init script is still running. NEW
workspaces left by a prior process initialize in the background once startup
completes, because worktree creation, the startup script and the default agent
session can take minutes. They initialize one at a time; periodic reconciliation
waits for that pass before querying, so it cannot initialize a workspace twice.
Shutdown stops reconciliation from starting more work as soon as cleanup begins.
It drains the in-flight initialization only after sessions and processes are
torn down, just before disconnecting the database: the startup script cannot be
cancelled, and new agent sessions fail fast once clients have stopped.

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

SQLite reads run synchronously on the main event loop, so hot workspace reads
leave out the large columns: `initOutput`, `creationMetadata` (base64
`initialAttachments` stay stored there until archive), agent-session
`providerMetadata`, and the PR `observation`. `findById`, the project list
(`findByProjectIdWithSessions`) and the 60-second snapshot reconciliation read
(`findAllNonArchivedWithSessionsAndProject`) omit them, and their return types
do too. Callers that need a blob use a named finder: `findInitStatus` for the
startup log, `findInitialMessageContext` for the first-message prompt and
attachments, `findMetadataContext` for auto-generated name provenance, and the
session and PR capsules' own reads for provider metadata and observations.

Polled and per-message reads follow the same rule. Project reads
(`project.getById`/`getBySlug`, and the 30- and 60-second review and issue
polls) load the project row without workspaces. Session reads join only the
workspace's `status`, `worktreePath` and `initErrorMessage`; terminal session
reads join the workspace without its blobs. Workspace session lists
(`session.listSessions`, the event collector) leave out `providerMetadata`;
`findAgentSessionById` still returns it. The child-workspace panel, the PR
watcher's monitoring list and both PR scheduler candidate reads select no blob
columns. The Prisma client has no client-level default `omit`:
`Prisma.TransactionClient` does not carry one, so functions that take a
transaction client, the backup export among them, would be typed as returning
columns that were never loaded. Narrow each read with `select` or `omit`
instead.

`workspace.get` reads `findDetailById`, which adds the `initialPrompt` for the
details dialog to that narrow row. Polled git, file and init-status reads use
the narrow `findWorktreeContext`/`findInitStatus` selects instead of full rows.

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
`config.worktree` invalidate only their owning worktree. Loose branch,
remote-tracking and tag refs (and their `.lock` files) invalidate only snapshots
that read them: the branch named by the worktree's private `HEAD`, and every
full ref Git could resolve the merge-base revisions it tried
(`origin/<defaultBranch>`, then `<defaultBranch>`) or its upstream to. A commit
or push in one worktree therefore recomputes that worktree, while moving the
default branch still recomputes everyone. A snapshot's refs are treated as
unknown, so any ref change invalidates it, while its calculation is running,
when `HEAD` cannot be read, when one of those refs is a loose symbolic ref, and
when the upstream lookup fails for any reason other than "no upstream
configured" or a detached `HEAD` (a configured upstream whose tracking ref is
missing could reappear). Ref names are compared case-insensitively after NFC
normalization, so canonically equivalent Unicode names match, and a directory
event covers every ref beneath it. Every other common metadata change still
invalidates every dependent entry, including `packed-refs`, other ref namespaces
such as `refs/replace`, shared config, info attributes and excludes, reftable
state, and events without a filename. Object and reflog writes are ignored
because the associated ref event performs the invalidation, and so is
`packed-refs.lock`: Git takes and releases it around ordinary loose ref updates,
while an actual rewrite also reports `packed-refs.new` and `packed-refs`. If the
shared watcher fails, all of its dependents switch to the five-minute fallback
expiry; removing the last dependent closes it. On Linux all of these watches are
nonrecursive, so installation never traverses dependency trees, Git objects,
logs or other worktrees. Linux snapshots expire after five seconds even with
healthy watches; existing snapshot readers refresh nested working-tree edits and
ref changes that shallow watches cannot see. Watch failures retain that
five-second limit on Linux. Other platforms retain recursive watching and the
five-minute failure fallback. Worktree removal closes its watchers before Git or
filesystem deletion and suspends watcher installation until that operation
settles. Concurrent snapshot reads cannot reinstall watches during deletion. On
success or failure, it retires any snapshots calculated during deletion; the
next read may recreate watchers lazily if the worktree survives.

Git snapshots keep one running calculation per worktree/default-branch pair.
Invalidation clears the cached result and fences the running generation without
detaching its Git commands. Readers arriving after invalidation share one fresh
calculation after the running work settles; bursts before that refresh starts
coalesce into the same refresh. A stale completion is never cached. Removal and
stop retire queued refreshes, and rejected Git commands reach callers
immediately while sibling commands drain before releasing ownership. The
existing three-command per-snapshot and six-command service budgets still apply
across independent workspace keys.

The board provider and its children are keyed by project ID. Switching projects
resets archive recovery and confirmation dialogs, Quick Chat, inline forms, and
the mobile board scroll and filter. Archive results arriving after a switch
still reconcile the originating project cache, but cannot open recovery in the
new board, even when the user has already switched back to the original project.

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

On phones, the shared app header puts the sidebar menu and breadcrumb or page
title in its first row. Status and action controls, search, and the panel toggle
occupy the second row. Both rows keep the same height across pages; long paths
truncate within the navigation row. Desktop and installed desktop PWA headers
retain a single row.

## Session needs-input status

Each `SessionSummary` carries `pendingRequestType` (`permission_request`,
`user_question`, `plan_approval` or null). `buildWorkspaceSessionSummaries`
classifies it from the live pending interactive request map through the shared
`getPendingRequestType`. The workspace-level `pendingRequestType` uses the same
classifier. A `pending_request_changed` event refreshes the workspace type and
the session summaries together, from one copy of the map.

`deriveSessionUiStatusKind` returns `awaiting-input` when a request is pending,
ahead of `working`. A blocked prompt still reports `WORKING` activity. Loading,
starting, stopping, error and exited states still take precedence. Chat tabs
show awaiting-input in the `attention` tone with one icon per request kind
(`src/client/lib/pending-request-presentation.ts`), and they do not pulse. While
the open chat has a pending request, the thinking footer and the composer
placeholder say what the agent is waiting for instead of "Agent is working".
Closing an awaiting-input tab still asks for confirmation, because closing it
stops the prompt.

The sidebar glow (`useWorkspaceAttention`) still fades after 30 seconds, even
while a request is pending. Pending-request transitions in
`useProjectSnapshotSync` dispatch attention events without playing the
completion sound; `useWorkspaceAttention` consumes those events and expires the
glow. The workspace's pending-request icon stays in the sidebar and the tab
status stays on the tab until the request resolves. A glow that never stopped
would keep animating for every blocked workspace.

## Completion notifications

Desktop completion alerts use the renderer’s browser `Notification` API in both
the web app and Electron. The unused backend desktop notification service and
its environment options (`NOTIFICATION_PUSH_ENABLED`,
`NOTIFICATION_SOUND_ENABLED`, `NOTIFICATION_SOUND_FILE`,
`NOTIFICATION_QUIET_HOURS_START`, and `NOTIFICATION_QUIET_HOURS_END`) have been
removed. These options never controlled the renderer alerts or durable
workspace/session notification delivery.

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

## Workspace tools on phones and foldables

Below 1024 CSS pixels, workspace tools open in a right-side drawer with a strip
of the session still visible. A compact 36px strip uses the shared underline
tabs for Changes, Files, and Terminal. The overflow menu keeps sub-agents,
screenshots, Inbox, and logs available, plus Runs for a scheduled automation
when one launched the workspace. It marks the current selection and shows the
selected tool as an additional underlined tab. The tab strip scrolls on narrow
screens while the overflow button stays visible. The selected tool survives
closing and reopening the drawer in the workspace. Selecting a file, diff, or
screenshot closes the drawer to reveal the main view. Wider screens retain the
resizable desktop split.

Terminal selection on compact or touch screens never automatically focuses its
input. Tap inside the terminal to type. The drawer tracks the visual viewport so
its content fits above the software keyboard, and closing restores focus without
focusing an editable control. Terminal processes continue on the server when the
drawer closes.

Crossing the 1024px drawer/desktop boundary remounts the tool presentation when
moving between the modal portal and the desktop panels. This is an accepted
layout boundary: client-only terminal scroll and transient tool state can reset,
while terminal processes remain alive and their buffered output is restored from
the server. Folding within the compact range (including the 344px, 690px, and
800px regression viewports) preserves the mounted drawer content.

### Event workspace setup retry

The existing setup Retry controls use
`workspace.getInitStatus.retryAvailability` for availability and a bounded
explanation. Unknown or unavailable authority keeps Retry disabled; blocked
event authority continues polling even when the workspace is READY or FAILED.
The backend independently rechecks every retry. The ordinary retry budget
remains three attempts, including READY workspaces whose worktree is missing.

An event workspace's retained origin identifies its owner before session or run
linkage. PENDING initial delivery, unresolved delivery, and a locally active
initial operation block generic setup retry. FINISHED delivery without active
initial work permits ordinary retry, including historical STARTUP preparation
and terminal runs. Missing or inconsistent owner facts fail closed.

Retry captures the exact initial attempt and carries it through queued
initialization, workspace transactions, scripts, startup and dispatch. Workspace
writers validate the captured owner under their existing SQLite write lock and
check local admission again before committing. Stale continuations cannot adopt
a replacement attempt or publish READY/FAILED; already-started physical work is
joined and cleanup targets only resources still owned by that operation.

A queued setup-warning retry rechecks the captured READY status, worktree,
warning and retry count after its predecessor drains. Concurrent requests do not
replay setup after an earlier retry changes that state. Default-terminal
registration retains the created PTY instance and row identity; rejected
registration cleans up that instance only, and PID clearing compares the
captured PID without treating a stored PID as process-stop authority.

## Workspace families

Workspace cards show a named parent link and a family menu. The workspace header
keeps a parent breadcrumb (an icon on phones) and the same menu for navigating
between the parent and its children, including workspaces in other projects.
Menus fetch family members when opened and display each member's own Kanban
state; archived parents remain navigable. Hovering or keyboard-focusing a Kanban
card highlights its family across columns without moving cards or changing
status. Child counts match the menu: archiving children remain counted until
archived. Optional parent summaries and child counts travel through the existing
HTTP/snapshot metadata projection; older summaries remain valid without these
fields.

## Projection field contract

`src/shared/workspace-projection-fields.ts` classifies every raw summary input
with its merge group, hydration requirement and drift policy. Snapshot group
merging, completeness checks, metadata schema selection and reconciliation drift
consume that inventory. Input types derive from the shared summary contract;
adding a raw field requires an explicit policy. Independent contract fixtures
check policy semantics rather than importing the production inventory.

Canonical PR collections carry `prCollectionRevision`, the sum of each retained
association's revision plus one. Detached associations remain in this sum so
attachment, detachment, and reattachment advance collection freshness even when
the visible collection becomes empty. Public PR lists exclude detached rows;
attached-only reads omit the collection revision because they cannot establish
the full membership history.

The summary schema also supplies common snapshot validators and the HTTP
projector's public field inventory. Legacy snapshots retain optional metadata,
PR collections and selection facts, and cannot claim completeness from defaults.
Selected PR identity and facts derive from accepted collections; they have no
independent clock or hydration requirement. Name and branch provenance remain
private and use their existing ordered-write fences. Reconciliation poll-start
fencing and client connection epochs and optimistic archive fencing are
unchanged.

## Board views and Waiting intervals

The sidebar's Board link shows Working and Waiting workspace counts for the
selected project as two count-only chips, including zero counts. The neutral
chip is Working and the orange chip is Waiting; a tooltip on hover or keyboard
focus of the Board link explains both counts. The link also retains both labels
for screen readers. They follow the same Kanban column groups as the sidebar
lists and update with workspace snapshots. Counts stay hidden until workspace
data is available for the project the Board link opens.

The board and sidebar use Todo, Working, Waiting, Done order. Todo opens the
in-app issue launch sheet; external issue links remain explicit. Issue loading,
provider configuration and fetch failures have separate states, with retry and
project settings actions. A failed refresh keeps cached issues visible alongside
its error and retry control. The sidebar hides Todo whenever there are no
assigned issues to display, including loading, disconnected and failed requests
without cached issues. The board retains its issue loading and recovery states;
without a selected project, its Todo column offers project selection/creation
rather than loading a disabled query. An empty project offers its first
workspace while keeping assigned issues available.

On phones, the shared top row contains the sidebar menu, breadcrumbs and global
search icon. The board filter, New workspace and board actions share the second
row. Desktop keeps the filter beside Board in the top navigation. It searches
workspace names, branches and conversation summaries plus issue
titles/identifiers across the entire board.

Mobile sections stack in Todo, Working, Waiting, Done order in one scroll
surface. Sticky, equal-width section links show counts, jump to a section and
track manual scrolling. The final section stays at its content height, without
extra space to force its heading to the top. Section jumps stop at the scroll
limit; an explicit jump keeps its selected link until the board scrolls again.
The app shell follows the visual viewport to keep the board above the software
keyboard. Filtering shows matching sections and updates every count; clearing it
restores all sections. Empty Todo provider/loading/error states remain visible
when unfiltered. New workspace scrolls to Todo, including when its form is
already open. Successful creation clears the filter and reveals Working. Project
switching resets the scroll, filter and form.

Waiting has a sort icon beside its section heading for Latest message (default)
or Created, both newest first. The choice persists in browser storage across
project boards and reloads, and updates other open tabs. Latest message uses the
workspace's latest session activity timestamp, falling back to creation when
unavailable. Done always uses Latest message order with the same fallback,
independent of the Waiting sort choice. Equal activity timestamps in Done are
ordered by creation time, newest first. Working keeps newest-created order.
Waiting cards omit waiting-duration labels. Ordering affects only the view,
preserving snapshot order. The board has no card selection controls. The
snapshot store records `waitingSince` when an accepted update changes an
existing workspace into Waiting, retains it across same-status updates and
clears it on exit. Initial Waiting hydration (including after server restart)
has an unknown start; creation and last-activity times never substitute for it.
No past interval is inferred.

Archive all in Done targets the entire column, including workspaces hidden by
the current filter.

## Held for other guides

Rules, hazards and reasons from the migrated sections that belong to another
area. Each entry quotes only the sentences it needs from the paragraph named
after it, verbatim, with `[…]` where sentences between them are left out. The
migration that creates the named area's guide checks the entry, moves what holds
there and deletes the entry here. Paragraph numbers are the rows of the
disposition table in pull request #3229.

> CI and sidebar status helpers and types have one internal import surface:
> `@/shared/core`. Their dependency-free implementations live in
> `src/shared/core/`; sibling core modules may import those files directly.
> These source paths are internal application code, not supported package
> imports. The published package exposes the `ff` CLI, not a shared-status SDK.

Old paragraph 1. For a dependency rule for `src/shared/core/` (task 2.10). No
rule enforces it, and 22 files outside import `enums.ts` directly today.

> Claude's structured-output schema uses JSON Schema Draft 7 for runtime
> compatibility.

Old paragraph 5. For the session capsule guide.

> Agent sessions are not covered.

Old paragraph 39, after "Terminals and setup, run, postRun and cleanup scripts
run the user's commands, so they omit the variables Factory Factory's launchers
set for its own backend". For the session capsule guide.

> Images dropped before draft storage loads wait in memory, so a refresh in that
> brief window loses them; once it loads they are saved to the draft and shown
> when the form opens.

Old paragraph 16. For the Kanban feature guide (task 2.5b).

> Periodic reconciliation still repairs missed events and restart state. Its
> 60-second interval is the delay after a completed run, not a hard maximum for
> stale UI: prior Git work, the next database read, and failed sweeps can delay
> repair.

Old paragraph 36. For the snapshots orchestration guide
(`src/backend/orchestration/snapshots/`, task 2.5b).
