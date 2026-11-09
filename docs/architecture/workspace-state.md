# Workspace State

CI and sidebar status helpers and types have one internal import surface:
`@/shared/core`. Their dependency-free implementations live in
`src/shared/core/`; sibling core modules may import those files directly. These
source paths are internal application code, not supported package imports. The
published package exposes the `ff` CLI, not a shared-status SDK.

## Conversation names and summaries

New prompt-created workspaces mark their initial name as generated. A disposable
small-model helper can replace that title once. Manual rename clears the marker;
metadata acceptance rechecks it in the same transaction, so manual edits win
even while inference is pending. Explicit titles, issue names, and resumed
branches retain their names.

`WorkspaceMetadata` stores the first title/branch suggestion, the latest card
and sidebar summaries, generation time, and source session/message cursor. Reads
flatten the validated record into `conversationSummary` on the shared workspace
contract. Snapshots carry it through reconciliation and reconnects; global
search matches summary text and returns a matching snippet. Cards show two
summary lines; sidebar rows show one focus line. Hovering exposes the full
summary and update time. Summaries use one short sentence (at most 25 words)
about current activity or the latest meaningful result, omitting decisions,
plans, next-step lists, and empty status statements. Operational status and CI
badges remain authoritative.

The first committed user message queues initial metadata. Completed turns queue
incremental updates using the original objective, previous summary, and bounded
recent human/assistant text. Tools, reasoning, images, and repository
instructions are excluded. A jobRunner job checks pending work every ten
seconds, coalesces turns per workspace, and limits inference to once per two
minutes. Pending final updates run after the cooldown without requiring another
message. Newer user messages invalidate pending initial metadata; unfinished
follow-ups preserve the pending completed-turn snapshot. Newer completed turns
replace that snapshot and invalidate its in-flight results. Persisted request
IDs reject superseded writes. Provider failures retain existing summaries and
back off up to ten minutes. Shutdown aborts inference and drains the job.
Pending requests are process-local; after restart, new conversation activity
queues another update.

Helpers use the conversation's provider and account: Luna with low reasoning for
Codex, Haiku for Claude. They use short custom instructions, no working-session
context, no tools/MCP, and no persistent provider session. Calls time out after
45 seconds. Claude's structured-output schema uses JSON Schema Draft 7 for
runtime compatibility. Workspace launch, chat dispatch, and publication never
wait on them. The saved branch suggestion feeds the existing pre-push/pre-PR
renamer while the branch is still marked auto-generated, with deterministic
naming as fallback. A local naming collision adds a short workspace suffix.

Environment controls: `WORKSPACE_METADATA_ENABLED` (default `true`),
`WORKSPACE_METADATA_CODEX_MODEL` (default `gpt-6-luna`), and
`WORKSPACE_METADATA_CLAUDE_MODEL` (default `haiku`). These are provider-native
calls using existing authentication; they consume the account's usage allowance.

Several workspace concerns were split out of the `Workspace` table into 1:1 side
tables. They share a shape: one accessor is the sole writer, and reads flatten
the row back onto the workspace under the field's original name, so the snapshot
wire aliases and v4 export format retain compatibility. PR reads additionally
expose the derived `selectedPrId`/`selectedPr` contract described in
[pull requests](pull-requests.md#pr-event-delivery-destinations). The selected
association's facts stay separate from the authoritative `prs`/`prSummary`
collection; selection is never persisted as a primary preference.

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

Dragging image files over the Kanban board highlights a drop target. Dropping
opens the new workspace form and appends the images to the project's creation
draft. The navigation sidebar has its own creation drop target, including while
viewing a workspace: dropping there opens the sidebar's new workspace form with
the images attached. The sidebar form loads on demand. Images dropped before
draft storage loads wait in memory, so a refresh in that brief window loses
them; once it loads they are saved to the draft and shown when the form opens.
Dropping over the main chat transcript or composer highlights the message
destination and appends images to that chat's composer. Existing instructions
and attachments are retained. Image limits and per-file errors match the
composer; chat drops require a connected, loaded chat that supports image
attachments. File reads finishing after a project or session switch or explicit
draft clearing are ignored. An accepted drop survives a temporary chat
disconnect while its files are being read.

The board keeps one creation draft per project in this browser, including
instructions, attachment contents, launch choices, PR updates, and
periodic-agent schedules. Cancel clears the draft and restores user defaults for
the next task. Escape and navigating away preserve the draft; **New workspace**
at the top of the Todo column (a main-pane toolbar shortcut on phones) reopens
it. The desktop button is hidden while the creation form is open and returns
when the form closes. Clear instructions by selecting and deleting the text;
remove attachments with their individual remove controls. Navigation and refresh
restore saved inputs. Browser storage failures appear in the form while editing
remains available; keep the tab open when a warning says changes could not be
saved. If a saved draft is unreadable, **Reset saved draft** appears beside the
restore warning to remove the invalid stored record and keep the editor open.

Creation request errors appear beside the retained inputs. An in-flight request
continues to own its project draft across composer remounts, preventing
duplicate submissions. Success clears only the submitted revision; a late
response cannot clear or close a newer draft or a composer in another project.
Standard workspace launches collapse the composer immediately while the
optimistic setup card shows progress in Working. If the standard workspace
creation request fails, its optimistic card is removed and the composer returns
with its retained draft and error.

Launching from the sidebar immediately selects a local pending workspace and
closes the form, while server validation and provisioning continue. The pending
detail view does not query the backend with its temporary ID. Success replaces
that route with the persisted workspace after seeding its detail cache, without
waiting for draft cleanup. Navigating away during creation prevents a late
response from changing the current selection. Failure shows the error and a link
back to the retained draft; a reload of a temporary route offers the board and
form instead of querying an invalid workspace ID. The local store retains the
latest 100 completed launch outcomes for temporary route recovery and never
evicts requests that are still creating a workspace.

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

The compact terminal tabs stay visible beside Logs. Switching to Logs keeps the
terminal connection, tab identity and selection alive, while hiding terminal
content. An empty Terminal tab opens Terminal 1 on click, after the server
terminal list loads; closing the last terminal while viewing it recreates
Terminal 1. Closing it from Logs leaves the empty Terminal tab until selected.
The server always sends the initial terminal list, including an empty list for
workspaces with no running terminals, so first-terminal creation can proceed.

Workspace terminals never automatically take keyboard focus when created,
restored, or selected. Click inside the terminal to type, so asynchronous
workspace initialization leaves focus in the composer or other active control.
The dedicated project setup terminal dialog explicitly requests focus on
desktop.

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

Setup failures retain the workspace and its original instructions and
attachments. The board shows **Setup failed** in Waiting, and the workspace
exposes **Retry setup** even when no chat session exists. Retrying uses the same
workspace. A creation response preserves an existing live summary rather than
replacing a newer setup failure with a synthetic Setting up state.

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

Terminals and setup, run, postRun and cleanup scripts run the user's commands,
so they omit the variables Factory Factory's launchers set for its own backend
(`NODE_ENV`, `DATABASE_PATH`, `BACKEND_PORT`, and the rest listed in
`src/backend/lib/user-process-env.ts`). Otherwise `NODE_ENV=production` from
`ff serve` or the desktop app would make `npm install` skip devDependencies and
run dev servers in production mode. Agent sessions are not covered.

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

Each dev-logs and post-run-logs connection first receives the retained output
buffer, when non-empty, as one `{ type: 'output', data, replay: true }` frame.
The buffer repeats output a reconnecting client already shows, so on a reconnect
`useLogStream` replaces its output with the replay rather than appending it;
with no replay frame (e.g. after a backend restart) it keeps the earlier output.

## Provider defaults

Provider-default updates return `NOT_FOUND` when their workspace was deleted,
including deletion racing the database update, without exposing Prisma error
messages. Other database errors keep their existing handling.

## Backup export

Schema-7 exports read relational data and saved account metadata through one
private, physically readonly SQLite transaction. The source connection
identifies its actual main database file; missing or in-memory databases fail
closed. Ordinary WAL writers can commit while export reads its consistent
snapshot. The snapshot has a 120-second transaction budget and a 5-second busy
wait. Account exports include identity metadata only, excluding credentials and
homes.

## Backup import

Backup imports require the same trusted local client boundary as project
creation. Project slugs and worktree base paths must be nonempty; legacy backups
with empty values are rejected before any records are imported. Valid backup
paths are preserved rather than recomputed for the current machine.

All import owners write through one private tuned SQLite transaction on the
source connection's actual main file, with a 120-second transaction budget and
5-second busy wait. A failed import rolls back its own rows without absorbing
ordinary application writes into that rollback. SQLite still permits only one
writer at a time. Contention or transaction expiry returns a CONFLICT asking the
operator to retry the whole import; no statements or rows retry automatically.
Validation and other database failures retain their original errors. A
disconnect failure after commit is a cleanup error, never a retry instruction.

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
`initialAttachments` stay stored there after init), agent-session
`providerMetadata`, and the PR `observation`. `findById`, the project list
(`findByProjectIdWithSessions`) and the 60-second snapshot reconciliation read
(`findAllNonArchivedWithSessionsAndProject`) omit them, and their return types
do too. Callers that need a blob use a named finder: `findInitStatus` for the
startup log, `findInitialMessageContext` for the first-message prompt and
attachments, `findMetadataContext` for auto-generated name provenance, and the
session and PR capsules' own reads for provider metadata and observations.

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
`config.worktree` invalidate only their owning worktree. Common metadata changes
invalidate every dependent entry, including shared config, refs, info attributes
and excludes, and reftable state. Object and reflog writes are ignored because
the associated ref event performs the invalidation. If the shared watcher fails,
all of its dependents switch to the five-minute fallback expiry; removing the
last dependent closes it. On Linux all of these watches are nonrecursive, so
installation never traverses dependency trees, Git objects, logs or other
worktrees. Linux snapshots expire after five seconds even with healthy watches;
existing snapshot readers refresh nested working-tree edits and ref changes that
shallow watches cannot see. Watch failures retain that five-second limit on
Linux. Other platforms retain recursive watching and the five-minute failure
fallback. Worktree removal closes its watchers before Git or filesystem deletion
and suspends watcher installation until that operation settles. Concurrent
snapshot reads cannot reinstall watches during deletion. On success or failure,
it retires any snapshots calculated during deletion; the next read may recreate
watchers lazily if the worktree survives.

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
screenshots, Inbox, and logs available, plus the scheduled automation when one
launched the workspace. It marks the current selection and shows the selected
tool as an additional underlined tab. The tab strip scrolls on narrow screens
while the overflow button stays visible. The selected tool survives closing and
reopening the drawer in the workspace. Selecting a file, diff, or screenshot
closes the drawer to reveal the main view. Wider screens retain the resizable
desktop split.

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
