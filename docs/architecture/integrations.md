# Integrations

## GitHub

GitHub URL imports use the shared `parseGithubUrl` validator for both the New
Project form and backend input validation. Invalid owner/repository segments
show an inline error and cannot be submitted; supported HTTP, HTTPS, and SSH
URLs keep the existing `.git` suffix and trailing-slash behavior.

Uses the local `gh` CLI's auth — there is no stored GitHub token. Issue fetch
supports Kanban intake (`listIssuesForProject`, assigned to `@me`). Starting
from an issue creates a linked workspace (`githubIssueNumber`,
`githubIssueUrl`).

Global search also supports GitHub issue lookup and launching; see
[Search](./search.md) for matching and request behavior.

GitHub project imports reuse existing clone directories when owner or repository
casing differs, preserving the existing path and local changes. New clones use
lowercase owner/repository paths, matching GitHub's case-insensitive names. URL
validation and the existing non-repository directory guard still apply.

Concurrent imports targeting the same normalized clone path share one in-flight
clone result. Clone-path inspection waits for that clone to finish before
classifying the directory, including clones started during directory scans. A
new clone waits for any active inspection of its destination to finish. Failed
clones can be retried, and cleanup never removes a completed repository.
Coordination is in-process and uses lexically resolved paths; filesystem aliases
such as symlinks to the same directory are not coordinated. Equivalent GitHub
HTTPS and SSH URLs share a clone, while a different source targeting an
in-flight destination returns an error without disturbing the active clone.

The New Project authentication badge requires a successful login line and a zero
exit status from `gh auth status`. Explicit login failures take precedence over
success lines, including mixed valid/invalid accounts and older CLI versions
that exit zero for invalid tokens. Both output streams are checked.

All `gh` spawns go through `GitHubCLIService`, which owns the process-wide
concurrency limit, the fast-fail on rate limiting, and singleflight dedup of
identical in-flight reads. Do not spawn `gh` directly from a service. See
[pull-requests.md](./pull-requests.md) for how the ratchet and the PR sync poll
share that budget.

Full PR metadata reads use a 10 MiB stdout buffer, like bulk diff and review
comment reads, to accommodate paginated reviews, comments, and status checks.
Responses above that limit still fail rather than returning truncated metadata.

Monitoring's `getPRStatusDetails` reads only PR/head/check metadata; with
monitoring on, `getPRObservationDetails` reads the same metadata plus
conversation comments in one `gh pr view`. Optional `getPRReviews`, review
comments and resolved threads share the existing CLI budget but cannot block
core observations when enrichment fails: a combined read that fails for any
reason other than an abort or connectivity failure falls back to
`getPRStatusDetails`. Review facts then remain explicitly incomplete, preserving
earlier feedback until a complete read or confirmed resolved IDs supersede it.
Abort and core-fetch failures still fail the observation. `getPRFullDetails`
retains its full detail-view contract. No extra polling loop is introduced.

Check-run conclusions preserve `STARTUP_FAILURE` through PR-detail mapping, so
both PR sync and Ratchet classify startup failures as failing CI, including when
other checks are still running. Sidebar and Kanban projections therefore agree
on the cached CI status.

Legacy status contexts retain their context names and target URLs through PR
snapshot parsing and use the same normalization as Ratchet. Contexts pointing at
GitHub Actions runs therefore use the latest run attempt in both paths, keeping
the cached CI status consistent after reruns.

CLI authentication checks normally use cached health. Closing the setup terminal
in admin settings or project onboarding, or choosing Recheck, forces a fresh
check through both the aggregate CLI cache and GitHub's own cache. Forced checks
wait for older refreshes before rechecking so pre-login results cannot overwrite
the new status displayed in the UI.

## Ticket dispatch prompt

Settings > General settings > Ticket dispatch prompt configures the instructions
used when starting GitHub and Linear tickets. The default retains the existing
instructions to fetch and address the issue, follow repository instructions, and
create a PR with a closing reference. The quoted ticket URL is appended after
the instructions; no template variables are substituted. Reset to default
restores these instructions. The launch sheet still allows edits for one launch.

## Issue provider settings

The admin provider selector rolls back failed saves to the latest project query
value. Successful saves update the cached provider so a failed refresh retains
the last confirmed value. After all overlapping provider writes settle, it
refetches projects and releases the optimistic selection. Older completions and
refetches cannot replace a newer pending choice. Idle selectors follow project
query updates without a remount.

## Linear

A per-project issue provider can be set to Linear with an encrypted API key plus
team selection. Kanban intake uses Linear issues assigned to the configured
viewer. Team selection loads every page of accessible Linear teams. Starting
from an issue creates a linked workspace (`linearIssueId`,
`linearIssueIdentifier`, `linearIssueUrl`), and workspace lifecycle events
best-effort sync issue state back to Linear. PR merge completion suppresses
concurrent attempts and successful repeats for the same PR during a collector
lifetime, including before startup reconciliation seeds the snapshot store. An
omitted PR URL does not change its identity; known URLs still distinguish PRs
with the same number in different repositories. Failed or incomplete transitions
retry on later polls, and a seeded merged snapshot is attempted after startup.
The adjacent `linear-merge-completion.orchestrator.ts` owns this attempt
protocol, with one owner per running collector lifetime. The collector retains
subscriptions and admits completion effects only for accepted PR invalidations.
Removing a workspace or stopping the collector clears completion tracking;
already admitted Linear work may still complete after cleanup.

Project settings updates enter through trusted-local tRPC input validation, then
`updateProjectSettings` coordinates repository validation, the final startup
command/path exclusivity check, and credential encryption before persistence.
Application composition injects only its project and encryption capabilities.
Omitted fields retain their stored values; explicit null clears nullable
settings. Omitting issue tracker configuration leaves the existing encrypted key
intact. Startup command/path changes use a conditional database write matching
both observed nullable fields, then reread and revalidate on contention. At most
five writes are attempted before returning a conflict for retry; deletion and
invalid final pairs retain their existing errors. Encryption runs once after
validation and the encrypted patch is reused, with no transaction held across
validation or encryption.

Project list, ID/slug reads, local and GitHub creations, updates and archives
share `toPublicProject`: the encrypted key is omitted and replaced with
`hasApiKey`, preserving other public fields. Internal project service reads
remain raw so trusted Linear and runtime consumers can decrypt stored
credentials. Public projection never mutates the stored record.

API key validation in admin settings clears earlier team choices before each
request. Editing the key requires fresh validation and team selection before
saving. Responses to superseded validations cannot restore earlier team choices.
Failed Linear settings saves retain the validated key and selected team for
retry. Successful saves clear the submitted form only if no key edits, team
changes, or newer validation have superseded the submission.

<a id="scheduled-agents"></a>

## Scheduled automations

Settings > General settings > Chat defaults > Automation permissions controls
scheduled and event automation runs independently of workspace permissions. It
defaults to Auto review for existing and new installations. Standard and Full
access remain explicit options. Changes apply to future runs; frozen event
launches retain their recorded access mode.

Schema-8 backups with the `base-json-periodic-config-1` profile include complete
periodic task scalar configuration and timestamps. Import preserves due slots,
clock/timezone values and monthly anchors, but restores every accepted task
**disabled**. Only tasks under newly imported projects are accepted; existing
identities and children of skipped projects remain untouched and are reported as
skips. Import results distinguish enabled tasks across the entire source section
from rows actually restored disabled. Periodic execution history is excluded.
Import and startup do not reserve or dispatch these tasks; enabling one later
uses the ordinary periodic task scheduling policy.

Current schema-8 `base-json-periodic-history-1` backups additionally retain all
execution scalar fields and canonical launch snapshots. Section-local markers
preserve SQL NULL versus stored JSON null for `launchSnapshot`. Restore accepts
only file-owned tasks and workspaces newly created by that import; conflicting
execution IDs, occupied workspace slots and unavailable dependencies are counted
separately. Historical workspace links can differ from current task
associations. RUNNING source rows become FAILED with an explicit historical-only
explanation and unknown provider outcome; completion timestamps are never
invented. Imported history grants no resume, retry, monitoring or scheduling
authority. Terminal rows remain unchanged; later explicit enable uses ordinary
scheduling to create new executions. Five earlier schema-8 profiles retain their
original contracts.

<a id="periodic-tasks"></a>

Scheduled automations are recurring instructions that create a fresh workspace
on a configured cadence (daily, weekly, monthly, or testing cadences every
minute / five minutes). Daily/weekly/monthly tasks can optionally run at a
specific time of day in the user's browser timezone (`scheduledTime` HH:MM +
IANA `timezone` fields). Daily and weekly periodic tasks with a scheduled time
advance calendar dates in the task timezone, preserving the scheduled day across
daylight saving changes.

Creating, editing and enabling a task schedules workspace launches, so those
`periodicTask` mutations require a trusted local client, like
`workspace.create`. Listing, reading and deleting tasks stay available to remote
clients.

Each execution runs the configured prompt, monitors the workspace until the
agent finishes, and advances the schedule. Concurrent runs are skipped. The
schedule advances from the slot that was due, so a run picked up late (for
example just past local midnight) keeps the following slot. A task that missed
more than a full period runs once instead of replaying the missed slots, then
resumes at the first slot still ahead: a daily 09:00 task caught up at 08:00
also runs at 09:00 that day, and weekly and monthly tasks keep their weekday and
day of month. Archived projects are excluded from due-task polling. Their task
definitions retain their enabled state and schedule, so overdue tasks become
eligible again when the project is unarchived. The atomic dispatch reservation
rechecks the project state: archiving between the due-task read and reservation
creates no execution and does not advance the schedule. The workspace insert
also checks project archive state atomically if archiving races an already
admitted run.

A run's outcome depends on its PR, workspace setup and Claude/Codex session:

- **PR created** when the workspace has an active PR.
- **Completed** when the agent goes idle without a PR or session failure, for
  example after finding nothing to do. Monitoring waits five minutes after
  workspace setup before deciding, so a queued prompt or late PR discovery is
  not missed.
- **Failed** when a session records a provider error, the Claude 4-hour turn
  timeout, or an unexpected process exit. Codex turns have no elapsed-time
  deadline. The run uses that session message as its error and does not wait for
  the five-minute window. Deliberate stops are not failures. A run also fails
  when workspace setup or launch fails, or when no agent session ever started
  its provider, because the agent never ran.

Runs never archive or clean up their workspace; a human reviews and archives it.
Archiving it before the run finishes records Completed unless a session failure
was recorded.

Default sessions are named **Agent**. Existing sessions named exactly **Periodic
task** display as **Agent** for the `periodic-task` workflow; custom names and
stored records are preserved. Default sessions use the `periodic-task` workflow,
so non-interactive Codex startup selects unattended execution mode and tool
approval prompts cannot stall scheduled runs.

The periodic capsule atomically reserves a `PeriodicTaskExecution` and advances
its schedule before emitting a typed `timer_due` event. The event carries that
execution ID as its correlation identity. The due-task poll supplies only a task
ID to reservation. Inside the transaction, reservation reads the current enabled
and due definition, rechecks active project and overlap exclusion, and derives
the calendar advance from that same row and admission time. Legacy monthly
anchors resolve from that row's creation date without a separate database read.
Prompt-only edits before admission therefore use the latest instructions;
calendar edits use their current pending slot or defer admission if it is still
ahead.

New executions persist a versioned `launchSnapshot` containing the actual
workspace name, project, instructions, cadence, timezone/time, monthly anchor
and due slot. Dispatch uses only this frozen snapshot, so later definition edits
cannot change an admitted launch. Legacy execution snapshots remain null:
historical instructions cannot be reconstructed safely from today's definition.
This additive execution field is historical evidence, owned by the periodic
capsule; it does not enable replay or move scheduled automations into
`AgentRun`. Composition wires its narrow timer dispatch port to the
`new_workspace` arm of `background-action-dispatch.orchestrator.ts`, shared with
PR delivery's `existing_sessions` arm. Timer dispatch awaits the injected
workspace launcher and returns the workspace ID; the periodic capsule owns
linkage, failures and completion monitoring.

The PERIODIC_TASK launch policy persists a fresh workspace and requires a
`periodic-task` / `Agent` session, without explicit provider resolution, CLI
preflight, or a capacity gate. Committed workspace creation publishes NEW to the
snapshot stream before waiting for that required session; the sidebar can show
it in Working immediately. Session failure propagates with the workspace
retained and published, no initialization scheduled, and the reserved execution
failed without a workspace link. Successful provisioning starts initialization
once in the background. A launched result means workspace and session creation
returned; worktree initialization continues in the background. It does not mean
the prompt or periodic execution completed.

Launch failures mark the reserved execution failed and retain its advanced
schedule. This includes archiving after admission but before the guarded
workspace insert: no workspace is created, and unarchiving does not replay the
already admitted run. A failed workspace-ID write leaves it running without a
workspace link until the existing 15-minute timeout marks it failed. Restart
does not re-emit reserved runs. The launch/link crash gap remains; there is no
replay or exactly-once guarantee. Timer events use no second run store, PR
ledger entry, session queue delivery or receipt protocol.

The UI calls saved instructions and triggers **automations**, each execution a
**run**, and the AI carrying out the work an **agent**. Existing `/agents` URLs
and stored identifiers retain their names for compatibility. Event automation
procedures use the `automation` tRPC namespace. The naming convention is
**Runs** for tool tabs and **Run history** for history headings, independent of
trigger kind; both kinds expose these views (see
[Runs and Events](#event-runs-and-events) for event-triggered automations).
**Scheduled** and **Event-triggered** describe the trigger or the creation
choice.

The mixed Automations page at `/projects/:slug/agents` groups definitions under
**Scheduled** and **Event-triggered** headings. Event pagination stays in its
group. Scheduled details use `/projects/:slug/agents/:id`; saved events use
`/projects/:slug/agents/:id?kind=event`. Both path segments are encoded. Missing
kind selects scheduled; invalid or duplicate explicit kinds show a bounded link
error. Owner-less legacy links remain scheduled-only; event links require a
project. The navbar project selector is the shared project context; Automations
has no separate project filter. Automations and project-wide Reviews remain in
the sidebar footer above global Settings. Settings links to Automations without
a duplicate editor. Project switches preserve the current section and clear the
selected definition. An explicit event kind selects only event definitions,
including when the destination has no event-triggered automations. Legacy
`/agents` and `/agents/:id` links resolve the definition's owner before trusting
a stored project selection, including archived owners. A definition belonging to
another project or an invalid ID shows project-local not found instead of
selecting another automation.

The Automations footer badge combines authoritative scheduled and event
summaries for the URL owner's project, including paused definitions and archived
project owners. Both queries must succeed before a count is known; partial sums
stay hidden. If either refresh fails, the prior successful combined value for
that same project remains visible. Unresolved owners and different projects
never borrow another project's value. It warns when any automation's latest
completed outcome is FAILED. RUNNING and SKIPPED retries retain that warning
until the same automation completes a run or creates a PR. The scheduled summary
query selects its latest terminal outcome by start time, then ID; the event
owner uses terminal timestamp and ID. Each summary is independent of history
limits. Both lookups walk an index newest-first instead of sorting history: the
`PeriodicTaskExecution(periodicTaskId, startedAt, id)` index and the raw-SQL
partial expression index `AgentRun_latest_terminal_idx`. Prisma cannot see the
latter, so keep the query's predicate and ordering identical to the index and
recreate it after any `AgentRun` table redefinition; plan tests guard both.
PR_CREATED clears an earlier event-run failure; source health errors do not
count as failed runs. It refreshes with management's 10-second cadence and after
definition changes. Unknown/loading projects hide the badge; loaded empty
projects show zero. A failed refresh retains the last successful count for that
project.

Automations stacks its rail and editor below 48rem of available content width,
including when the workspace sidebar is expanded. Schedule fields share a row
only above 26rem of their own available width. Resizing preserves form drafts.

**Create automation** opens the same explicit **Scheduled automation** /
**Event-triggered automation** menu in the header and empty state. Scheduled
opens the existing schedule form. Event opens a normal workspace composer with
instructions to discover sources and propose an event configuration for review.
Its draft is separate from the project's normal/scheduled workspace draft, and
its launch mode stays standard. The proposal card still requires explicit
creation of a paused definition, which listens only after **Enable** on the
saved detail. While the workspace is being created, the route shows progress; a
failed creation restores the draft for retry. Archived and unresolved selected
definitions retain their existing creation restrictions.

Scheduled create/edit use Name, Instructions and Schedule. Creation makes the
first run due immediately; the existing periodic-task poll admits it, then
follows the configured schedule. No new timer or admission policy is introduced.
An unchanged clock time keeps an edited automation's timezone; changing the time
uses the browser timezone. Clearing the time or switching to a minute cadence
clears both schedule fields. Kanban's **Create automation** launch mode keeps
its instructions composer and uses the same schedule controls. It remains
available while chat provider defaults load. No provider or unattended-execution
policy changes accompany this UI.

Pause affects future runs; an already running workspace continues. Saving an
edit with an unchanged schedule keeps the pending run. Changing the schedule
starts at the first slot still ahead, which can be later the same day or month;
a weekly automation keeps its weekday. Resuming keeps a pending run that is
still ahead; an overdue one moves to the next slot on the same weekday, day of
month, and time rather than running at once. Deleting an automation requires
confirmation and removes its definition and execution history, while existing
workspaces and conversations remain available. Failed requests show an error and
preserve form drafts. The management page polls task/history data without
replacing unsaved edits.

Both the management page and the workspace's **Runs** origin panel use the
shared run history query, showing up to 50 recent runs with status, start time,
workspace/PR links and errors. Workspace links use the automation owner's slug
and remain available for non-null IDs, including archived workspaces. A running
run without a workspace ID says no workspace yet; a terminal run without one
says workspace unavailable. The origin panel links back to automation
management.

The workspace's provider subagent/child-workspace tab is **Subagents**. Stored
panel keys remain `agents` for Subagents and `periodic-task` for Runs, for both
scheduled and event-run workspaces. Once workspace data loads, an unavailable
origin tab falls back to Changes, as does a retired auto-iteration preference.
Deleting a definition therefore cannot leave that panel blank.

Service capsule: `src/backend/services/periodic-task/`.

Backups using `base-json-periodic-links-1` preserve current workspace task links
only when the workspace and disabled task are newly created by the same import.
File-owned cross-project links remain valid. Null links stay null, including
workspaces whose task was deleted; no execution history or launch authority is
inferred. Earlier profiles retain their original field coverage. Link result
counts cover nonnull source links and overlap the primary workspace counts;
unavailable dependencies are skipped atomically with their workspace group.

## Event-triggered automation data model

The automation persistence foundation lives in `AgentDefinition`,
`AgentConnection`, `AgentTrigger`, `AgentRun`, and `AgentProposal`, owned by the
`agent-definition` capsule. It is additive: existing `PeriodicTask` definitions,
executions, polling, and UI remain authoritative for scheduled automations. No
definitions are copied into the new tables. Migrating the scheduler is a
separate change.

- A project owns automation definitions. Each definition stores task
  instructions, versioned execution configuration, and an enabled flag.
  Definitions have no mandatory schedule and default to paused. Explicit model
  or reasoning-effort settings require a provider; model compatibility uses the
  same shared normalization as interactive session launch.
- Connections identify reusable Slack workspaces or GitHub installations, unique
  by provider and external ID. Optional credentials belong in
  `credentialsEncrypted`, using the existing encryption service; never put
  credentials in trigger configuration or run snapshots. Public connection APIs
  return only metadata and credential presence.
- A definition owns any number of independently enabled triggers. Schedule,
  Slack-message, and GitHub-issue triggers retain the user's natural-language
  `description` alongside resolved, versioned `config`. Optional
  `filterInstructions` are separate from the automation's task instructions.
  Triggers default to paused. Future admission must check the definition,
  trigger, connection, and project state.
- Runs have an automation-scoped unique `idempotencyKey`, optional trigger and
  workspace links, status, lifecycle timestamps, error text, and frozen
  definition/trigger snapshots. Their input is normalized source context rather
  than arbitrary provider JSON. A null trigger supports manual runs. One
  workspace belongs to at most one run. A queued row is a reservation, not
  evidence that an agent started.

The public contracts are exported from `@/backend/services/agent-definition`;
backend and client-neutral schemas live in
`src/shared/schemas/agent-definition.schema.ts`. Future writers must validate
JSON configuration, run inputs, and snapshots with these schemas. Schedule
triggers must have no connection; Slack and GitHub triggers require the matching
provider connection. JSON schemas validate shape, not relational state: the
future persistence boundary must also check that a referenced connection has the
expected provider and that a linked workspace belongs to the definition's
project. Provider event adapters must resolve channel/repository IDs within that
installation before matching.

Database constraints prevent duplicate installation identities, duplicate run
keys within an automation, and runs referencing another automation's trigger. A
connection with configured triggers cannot be deleted. A trigger with run
history must be paused rather than deleted. Deleting a definition cascades its
triggers and run history but retains its workspaces. Deleting a workspace clears
its run link without deleting run history. Editing definitions or triggers does
not rewrite stored snapshots; launch writers keep them frozen. Opt-in terminal
context expiry is the sole maintenance exception, using a validated expired
state.

The agent-definition capsule also owns the durable event runtime foundation:
`AgentSourceState`, `AgentEvent`, `AgentEvaluation` and `AgentInitialDelivery`.
Its barrel exports `ingestEvent`, `finalizeEventOrder`, `recordEvaluation`,
`admitRun` and `claimNextRun`. These are persistence primitives; the runtime
jobs and the activation flow below drive them.

Events use the immutable `(connectionId, providerEventId)` identity and bounded,
versioned GitHub/Slack payload schemas. Evaluations retain their definition and
trigger revisions, activation generation, decision and validated snapshots.
Admission checks current ownership, revisions, readiness and provider boundaries
in a serialized transaction. One definition/event produces one run; the first
matching trigger in stable ID order owns its context, and an earlier unresolved
or errored evaluation blocks later admission. Claiming a run reserves capacity
and fences subsequent worker writes with a generation. Provisioning and
uncertain running deliveries continue to occupy capacity.

GitHub `sourceOrder` is a canonical connection ordinal established from provider
API order after a complete fixed-head interval is captured. It is never arrival
order or a numeric provider ID comparison. Newly captured events remain
unfinalized until then. Finalization accepts oldest-first chunks of at most
1,000 new events, rejects mixed finalized/unfinalized chunks, and supports
idempotent retries of a wholly finalized chunk. The source state's
`lastSourceOrder` survives event pruning. Activation must finalize all events
older than its provider head before recording that boundary's ordinal. A head
can be a PR or unsupported control event with no executable event row, including
an ordinal of zero. Slack compares exact provider timestamp strings against
verified per-channel boundaries.

GitHub intake uses authenticated repository issue-event reads through the shared
`GitHubCLIService` budget. Only `labeled` and `reopened` issue events enter the
executable ledger, carrying the issue's labels as read at capture (at most 100);
PRs, including reopened PRs, rows without an issue (GitHub documents `issue` as
nullable), and other actions retain only their feed identities as control
anchors. GitHub reports a deleted actor or issue author as a null user; the
event still enters the ledger, with a null `actorId` or `creatorId`. Intake
stores those identities, but matching, evaluation and the starting prompt never
use them, because actor filters stay rejected. The configured project path must
resolve to the connection's numeric repository identity on each cycle, including
after repository renames. Paused authoring remains inert: only configured
(`isConfigured = true`) active triggers or explicit starting activations on
non-archived projects are source targets.

Runtime composition resolves GitHub reads and page limits from the owning
application graph. Incomplete project paths are omitted from a shared source; if
no complete path remains, the source is unavailable. Complete paths resolving to
a different repository identity still require recovery.

`AgentSourcePage` retains immutable page identities, captured event references,
and completed interval high water. Capture, event insertion and continuation
commit in one transaction. Capture and a second ordered verification traversal
share the ten-page cycle budget, resume with persisted overlap, and keep the
original head fixed. Resumed capture accepts a previously consumed overlap
prefix replayed at a page boundary after head insertion, while requiring an
ordered run within each page. Unknown leading identities after a larger shift
restart the search for the complete window. An overlap-only page clears its
completed window so the next cycle advances rather than replaying the same page
indefinitely; new capture establishes the next overlap window. The verification
pass still checks every captured identity before publishing source order. When
new head events move a resumed verification overlap, verification rechecks from
the fixed head rather than ignoring unknown middle items. These reads share the
same cycle budget. New head events wait for the next interval. Missing anchors
or observed sequence changes stop intake with `RECOVERY_REQUIRED`; no cursor is
silently reset. Recovery health and its original reason remain a durable fence:
normal failures, baseline preparation and late page/chunk writes cannot clear or
advance it; only an explicit [source reset](#source-reset) lifts it. GitHub's
offset pages are not a snapshot, so these checks detect observed discontinuity
rather than guarantee lossless capture under arbitrary provider deletion or
reordering. Finalization requires verified durable scan evidence and commits
each oldest-first chunk with its progress before another interval can start.

`AgentSourcePollService.prepareBaseline(connectionId, signal)` requires an
active or starting source and returns a baseline ID plus a nullable boundary. An
initial baseline saves the actual head (or empty marker) without backfilling
historical events. An already-polled source retains a prepared head in
`AgentSourceBaseline` until all older events have canonical ordinals;
`getBaseline(connectionId, id)` reads that result. A non-executable head can
have ordinal zero. Retained completed-interval evidence also resolves
preparation that races a newer commit, even after event rows are pruned. These
methods do not enable any trigger; [enable and pause](#enable-and-pause) owns
that.

`AgentSourceCheckpoint` and `AgentSourceHead` retain indexed API-order evidence
for every captured identity, including unsupported/control heads. A head's
canonical ordinal is its completed interval highwater minus the number of newer
executable entries. Control-only intervals therefore retain identities even when
the highwater does not advance. Each capture transaction adds at most 100
provisional head rows; the finalization transaction publishes their highwater
only after ordered verification, including the previous committed boundary.
Verification persists the live scanner's page/resume state. Discarded shifted
overlap observations restart proof from the fixed head; unknown identities
between verified pages and capture after verification fail closed. Live and
indexed verification share the skipped-identity and shifted-prefix guards.
Legacy backfill recovers the boundary identity from retained pages and treats
its derived ordinal as provisional. Publication requires an independent retained
witness and agreement from every non-null baseline, finalized marker, and
indexed head for that boundary, checked within the same bounded authority
traversal. Conflicting or missing boundary proof remains intact. Partial or
invalid checkpoints never serve historical lookups. Fully indexed intervals wait
until all legacy finalized intervals have been indexed before conflict checks
can publish them. Promotion keyset-traverses at most 100 retained authority rows
per transaction across finalized markers, heads, and baselines. Each row uses
unique point joins. Each head also checks the minimum and maximum issued
baseline orders through two indexed seeks, including claims for older intervals.
A head reserves three units of the shared row budget for itself and those
witnesses; repeated head identities or baseline pins cannot expand a join or
probe. Every finalized marker must match its own checkpoint head and highwater.
A persisted cursor counts the candidate's heads and records the connection
authority revision. SQLite triggers advance that revision when consulted proof,
checkpoint head/boundary/count, or ordinal claims change; validation restarts
from the beginning at a new revision. The final chunk and publication share the
ledger writer lock. Small intervals can publish during finalization; larger
intervals remain INDEXED with their full pages until maintenance finishes.
Continuous authority writes can defer completion, but cannot authorize partial
validation. Conflicting ordinals fail closed and retain their original proof.
Any rejected interval fences new baseline preparation (including the current
committed head) and page compaction for that connection's epoch, since later
pages may contain unexamined conflicting heads. Already-issued baseline IDs
remain readable through `getBaseline`. The verifier progress migration resets
older BUILDING checkpoints for replay from their retained pages. Subsequent
serialized maintenance replays them without deleting their heads or interrupting
active source scans. INDEXED, COMPLETE, and rejected checkpoints retain their
existing status.

During legacy capture replay, an observation without any indexed identity can be
a boundary-only continuation only when the next retained page starts
verification. Observations still searching for shifted overlap do not establish
a boundary.

Each operational target in a poll cycle also advances at most one legacy proof
page or one authority-validation chunk in a serialized maintenance transaction.
Until its entire interval is verified, historical baseline preparation falls
back to retained CAPTURE/FINALIZED proof. After completion, maintenance can
remove at most 100 redundant CAPTURE/VERIFY pages per transaction. Proof pages
for active scans, missing or malformed proof, and incomplete checkpoints remain
retained. Checkpoint metadata can advance through backfill or become invalid
without deleting those proof pages. FINALIZED markers, head checkpoints and
issued baseline rows remain indefinitely, preserving both exact historical head
lookups and `getBaseline(connectionId, id)` answers after event pruning and page
compaction. No age or current-reference rule deletes that retained evidence: a
provider baseline read may still be in flight before its pending row exists.
Source pages contain compact provider/control identities, not full source text.
These tables do not change event-ledger replay retention or activation fences.

Defaults are one active run per definition, four globally, 100 waiting runs per
definition and 24-hour waiting expiry. The first three limits are configurable
through `AGENT_ACTIVE_PER_DEFINITION`, `AGENT_ACTIVE_GLOBAL` and
`AGENT_WAITING_PER_DEFINITION`. Queue overflow and expiry produce durable
reasons. Instruction/execution edits advance the definition revision, pause
triggers and cancel unclaimed runs. Trigger edits do the same for that trigger;
cosmetic name edits preserve activation. Work claimed before an edit keeps its
frozen settings.

Existing evaluation maintenance clears eligible event payloads/evaluations at 30
days and event identities at 90 days, measured from occurrence rather than
observation. Each pass inspects bounded rotating pages under the ledger write
lock and captures expiry time after locking. Unresolved runs, retry/admission
cohorts, STARTING activations, malformed or unavailable dependency proof and
active GitHub scan identities remain retained. Evaluation dependents are removed
before identity deletion; retained run event links become null. Source high
water, cursor, recovery health, proof pages and baselines remain unchanged.
Automatic admission independently rejects events older than 30 days, including
replays after tombstones expire. Frozen run input and provider conversations
have separate lifetimes, so ledger pruning does not erase all source text. Run
context defaults to indefinite retention. Setting
`AGENT_RUN_CONTEXT_RETENTION_DAYS` to a positive whole number (at most 365000)
opts into expiry measured from `completedAt`; absent, blank or invalid values
retain context. Existing evaluation maintenance inspects one additional rotating
page of at most 100 run candidates per cycle. It acquires the ledger write lock
before sampling policy/time and rechecking terminal status, finished launch,
retry/lease, source/evaluation and delivery dependencies. Child workspaces no
longer block a terminal run's context. Active, uncertain, malformed or
recovery-dependent rows remain intact; expiry never retries or resends provider
effects. Batch metrics contain counts and bounded reason codes, without context
or run identifiers.

`AgentLedgerRetentionService.inspectRunContexts({ retentionDays?, after? }, signal)`
previews one bounded page in a read-only transaction. Omit `retentionDays` to
inspect the configured policy (default retain); supply prospective positive days
to preview eligibility without enabling deletion. The result contains eligible
and retained-reason counts, an independent next cursor, and logical UTF-8 byte
impact for snapshot JSON plus diagnostic text. A positive `eligibleDelta` means
growth; a negative value means reduction. This excludes SQLite/file overhead and
is not a physical disk-space guarantee. Inspection neither updates rows nor
advances the maintenance cursor. An exhausted inspection page is empty with a
null cursor; only maintenance wraps to revisit retained candidates. Its snapshot
is advisory: pruning independently rechecks eligibility under the ledger write
lock. Byte serialization is confined to inspection rather than added to the
destructive maintenance lock scope.

A disposable mixed fixture measures lookup counts/timings and the observed
write-lock scope without production data. Reproduce it with
`pnpm test src/backend/services/agent-definition/resources/agent-run-context-retention.integration.test.ts -t "bounds a mixed fixture preview" --maxWorkers=1 --reporter=verbose --silent=false`.
The fixture validates predicted versus actual logical byte change, read-only
inspection, the 100-row bound, and cursor independence; its wall times are
observations under the current host load, not production benchmarks or SLAs.

Eligible expiry replaces `definitionSnapshot`, `triggerSnapshot` and `input`
together with `{ version: 1, state: "EXPIRED", expiredAt }`, clears copied
`errorMessage` diagnostics, and sets `contextExpiredAt` in the same transaction.
`storedAgentRunContextSchema` validates the retained or fully expired state;
launch input schemas continue to require complete executable snapshots. History
reports context availability separately from the compact result/initial outcome.
Run identity, status, revisions, result/PR links, execution binding, delivery
proof, and retained workspace/session/child origins remain unchanged. Provider
conversations, evaluation snapshots, source payloads and live authoring settings
have their own lifetimes; run expiry is not a promise to erase all source text.
The additive migration marks no existing contexts expired and needs no backfill.
Logical recovery readers must preserve the expired representation and timestamp;
expired context is historical data and cannot authorize a launch.

Compact run results and PR links survive workspace and event deletion. Logical
export/import still excludes the agent tables and credentials; the complete
supported backup is the database file together with `encryption.key`.

### Enable and pause

Trusted-local `automation.enable` and `automation.pause` take
`{ projectId, agentId, expectedManagementRevision }`; a stale revision is
`CONFLICT` and a foreign owner `NOT_FOUND`. They are user actions only; the MCP
catalog has no activation tool. Enable applies to the whole automation. It runs
the same server-side validation `validateDraft` previews (current source access
and native model/effort support) and fails with `PRECONDITION_FAILED` and the
reasons when execution is not validated or no trigger is supported. Otherwise,
in one transaction, it persists `AgentDefinition.validatedIntent`
(`{ version: 1, definitionRevision, validatedAt, execution }`), enables the
definition, pauses configured triggers that are not supported, and moves each
supported paused or starting trigger to `STARTING` with a new activation
generation and a pending activation that expires after 30 minutes.
Already-active supported triggers keep listening. Enable then prepares one
GitHub baseline per connection and records it on each pending generation.

A trigger becomes `ACTIVE` only in one transaction that finds its baseline
resolved and its definition revision, trigger revision, membership, validated
intent, connection and project still permitting it; the boundary is that
baseline. Every write is fenced on the exact generation, so an execution or
trigger edit, or Pause, during preparation leaves the trigger `PAUSED`; a
cosmetic name edit does not interrupt activation. The `agent-source-poll` job
completes pending generations after each cycle. A generation that cannot
complete returns to `PAUSED` with `pausedReasonCode` `SOURCE_ERROR` (baseline
preparation failed or the connection is unavailable),
`SOURCE_RECOVERY_REQUIRED`, or `ACTIVATION_EXPIRED`. Pause disables the
definition and, through the shared `pauseTriggers` helper used by edits, moves
every trigger to `PAUSED`, advances its generation, clears pending activation
and boundary, and cancels unclaimed runs; claimed runs finish. Re-enable always
takes a fresh baseline, so events from the paused period never run.

Runtime source targeting, evaluation, admission and claim require
`isConfigured = true`. Activation and admission refuse a definition without a
validated intent for its current `definitionRevision`
(`EXECUTION_NOT_VALIDATED`). The intent is a gate, not a freeze: explicit
provider, model and effort are pinned by the definition, while inherited
settings follow current defaults at admission, so changing a default neither
pauses the automation nor makes the intent stale. Admission applies the same
native normalization as validation: an inherited effort the model does not offer
becomes the native default (or none), an absent one stays absent so the provider
default applies, and an explicit unsupported one is a permanent
`INVALID_EXECUTION_CONFIG` evaluation error. Native discovery failures retry
with the bounded evaluation budget and never launch. Logical export omits
`validatedIntent`; restored definitions stay paused until enabled again.

### Source reset

Trusted-local `automation.resetSource({ projectId, connectionId })` is the
explicit decision to give up on the gap behind a GitHub `RECOVERY_REQUIRED`
fence; the MCP catalog has no reset tool. The project must have a configured
trigger on the connection (otherwise `NOT_FOUND`) and must not be archived.
Apart from the repeat described below, any other source health is
`PRECONDITION_FAILED`. One ledger transaction pauses every trigger on the
connection, across definitions and projects, through the shared `pauseTriggers`
helper: each advances its activation generation, has its boundary, pending
activation and `pausedReasonCode` cleared, and has its queued runs cancelled
with `STALE_REVISION`; claimed runs continue. It returns
`{ connectionId, pausedTriggerCount, cancelledRunCount }`, where the trigger
count covers every trigger on the connection. No trigger is enabled: each
automation needs Enable again, whose baseline captures the then-current head.
Events from the gap never run.

The reset opens a new source epoch. `AgentSourceState.epoch` advances,
`epochStartSourceOrder` records the retained `lastSourceOrder`, and the cursor
is cleared with health `DISCONNECTED`/`GITHUB_SOURCE_RESET`. The next baseline
records the then-current head in the epoch with that high water as its ordinal,
so `lastSourceOrder` never moves backwards. Pages, checkpoints, heads, baselines
and events record the epoch that wrote them. Ordinal authority is per epoch:
historical head lookups, pending-baseline resolution, required-baseline checks,
the rejected-proof fence, maintenance and checkpoint promotion read only the
current epoch. A provider identity can therefore have different ordinals in
different epochs without invalidating new proof. An empty feed's head marker has
the epoch's starting ordinal, so an activation boundary with a null head carries
that ordinal rather than zero.

Reset never deletes or rewrites retained proof. Earlier epochs' FINALIZED
markers, checkpoints, heads, pages and baselines stay exactly as they were;
maintenance no longer backfills, promotes or compacts them, and
`getBaseline(connectionId, id)` still answers every issued ID. An event captured
but never ordered before the reset can never receive an ordinal: capture fails
closed with `RECOVERY_REQUIRED` if an earlier epoch's event reappears, and
finalization rechecks each event's capture epoch. Those events' payloads expire
as usual, but their identities stay retained as unordered source dependencies,
as they do behind a recovery fence. Evaluation and admission of a paused
generation are rejected as stale, so an event mid-evaluation when the reset
commits admits no run. A repeated reset before a fresh head is captured returns
zero counts and changes nothing, including triggers enabled since; after that, a
healthy source refuses reset.

### Project-owned saved management

Trusted-local `automation.list`, `get`, `updateSaved`, `evaluations`, `runs`,
and `navigationSummary` procedures manage project-owned event definitions even
after the authoring workspace/proposal is deleted. Inputs carry project
ownership; foreign IDs are not found. History uses bounded timestamp/ID keyset
pages (50 by default, at most 100), with independent evaluation and run pages.
Navigation counts every definition and its latest terminal event-run outcome
independently of those pages. Archived projects remain readable; writes and
discovery require an active project. Scheduled automation APIs and routes retain
their existing behavior.

`automation.list` accepts the optional `direction: "forward"` metadata added by
tRPC infinite queries and removes it before domain validation. Pagination
remains forward-only; unrelated input fields are still rejected.

`managementRevision` is the shared optimistic save token. Both saved replacement
and accepted-proposal edits increment it once, including a rename/no-op. Saved
edits also synchronize a surviving proposal's revision and local-ID
specification, so a stale editor on either surface conflicts. Execution
`definitionRevision` still changes only for task/execution edits; claimed
snapshots are immutable. Saved trigger IDs are persisted IDs, not proposal-local
IDs. Omitted IDs create new members; omitted existing members retain their
history rows.

Nullable `AgentTrigger.isConfigured` distinguishes current (`true`), removed
(`false`), and unknown legacy (`null`) membership. Migration does not infer
membership from PAUSED, ACTIVE, enabled flags or old runs. Any unknown row makes
the exact configuration unavailable; bounded candidate records remain
inspectable. A complete saved replacement establishes the entire membership set.
Included unknown or reintroduced removed rows take the changed-trigger path:
advance trigger revision and activation generation, pause, clear
pending/boundary proof, and cancel affected queued/PENDING work. Known unchanged
members preserve activation on rename. Historic actor restrictions remain
visible with an unsupported reason and require explicit removal in a
replacement. A valid complete save can replace malformed previous trigger or
execution configuration; it follows the same revision, pause and queued-work
invalidation rules. Invalid new input is still rejected.

`projectSources` shares the authoring source policy: actual project repository,
repository-scoped GitHub connection and verified labels; existing Slack bot
connection/channel access. No display name proves access. Project/connection
facts are rechecked after source awaits and inside save transactions. Slack
discovery rechecks enabled credentials and workspace identity after channel and
repository lookups; stale selected channels fail, and stale connections are
removed from the discovery list. Connections remain global installation
identities rather than gaining a project foreign key.

Explicit `validateDraft` is a POST mutation so full draft instructions travel in
the request body. It returns per-trigger capability reasons and a separate
native validation result. It uses the configured public session launch-options
service, including its bounded no-prompt discovery/cache, native model
confirmation and Codex preview-account isolation. Intent preserves requested and
confirmed models, explicit/inherited selections, and pinned reasoning effort.
Unsupported explicit effort fails; unsupported/absent inherited effort
normalizes to a supported native default or explicit null. This preview neither
freezes a future run account nor authorizes activation; Enable repeats the same
validation on the server. Ordinary reads never invoke native discovery. Only
labeled and reopened GitHub events can pass this milestone's source
capabilities; other GitHub actions (`opened`, `edited`), Slack intake, SCHEDULE
and actor filters report specific unsupported/unavailable reasons while
remaining inspectable drafts. Natural-language `filterInstructions` report
`UNSUPPORTED_SEMANTIC_FILTER` unless the automation's provider passed the live
classifier gate. Draft validation and Enable check the provider resolved at that
moment, including an inherited one; ordinary reads do not resolve providers, so
they report an inherited provider as supported only when every provider passed.

History exposes bounded reasons, nullable start times, separate automatic
attempts and send generations, preparation/delivery state and durable deadlines,
immutable initial outcome, compact result/PR links and retained workspace
provenance. It excludes raw prompts, provider evidence and unrestricted errors.
Pruned event text or a null event FK does not erase run identity or prove
completion. The workspace owner's retained-origin read covers creation before
linkage and deletion; it is provenance, not work proof or permission to retry
setup. Public history confirms LIVE only through that retained-origin owner; a
live run FK with missing reservation or origin returns a bounded NOT_FOUND.
Never-created reservations remain RESERVED, and runs without workspace claims
remain UNRESERVED. LIVE means an extant owner-validated workspace row, including
archived rows; it does not mean ready or running. Null result/preparation
metadata means no validated public metadata is available, not an empty result,
completion or cleanup.

The saved event detail/editor consumes these project-owned APIs independently of
its authoring workspace/proposal. It displays saved instructions, execution
settings, configured versus retained trigger records and each trigger's state in
words (see [Enable, Pause and Reset source](#event-activation-controls)), with
stored codes, revisions and inspected raw JSON in collapsed **Details**
sections; the editor keeps its editable JSON fields visible. Editing captures
managementRevision once; polling and CAS conflicts preserve all entered fields
and the original token. Reloading is deliberate. Saved edits invalidate the
captured owner and matching surviving proposal cards; proposal edits refresh the
same saved owner.

A complete valid specification initializes the field/JSON editor without
rewriting inherited execution omissions. Unknown membership, null or invalid
stored configuration starts as read-only inspection. An explicit complete
replacement starts with a blank full-specification JSON input, validated by the
saved schema. It never reconstructs membership from retained pages or silently
removes historical actor restrictions. Source refresh and native validation are
explicit user actions; validation is a POST preview of the current full draft
and grants no activation or account authority. Late previews cannot certify
newer drafts. Archived details remain readable with writes/previews disabled.

<a id="event-runs-and-events"></a>

Below the saved detail, **Runs** and **Events** tabs read `automation.runs` and
`automation.evaluations`, newest first, 50 per page with **Load more**. Both
poll at the management cadence; a refresh reloads every loaded page from the
first cursor, so new runs never open a gap. The client reads pages through the
plain tRPC client under tRPC's infinite key because the strict history input
rejects the `direction` field tRPC's infinite hook adds. A failed refresh or
next page keeps loaded rows with a retry notice; a failed first read shows an
error, never an empty state. Saved edits invalidate both views.

A run shows its status in words (Queued, Starting, Running, Needs attention, PR
created, Completed, Failed, Cancelled), a readable phrase for its reason code
(the code stays in the phrase's title and a collapsed **Details** section with
identifiers, attempts and first-message state), queue expiry or next attempt
while active, retained PR links and summary, and expired run context. Only a
LIVE workspace state links to a workspace; otherwise an active run says no
workspace yet and a finished one says workspace deleted (DELETED), no workspace
was created (UNRESERVED) or workspace unavailable (RESERVED). A null result is
shown as nothing and a null event link reads "Event record no longer kept" in
Details; neither is presented as empty or completed. Each run row has an action
slot for recovery controls. An event row shows Matched, Skipped or Error, its
trigger's description (or ID when the trigger is outside the loaded definition),
a phrase for its reason, whether it started a run, and any next attempt. The
history API returns a fixed placeholder `explanation` rather than the stored
one, so the view does not show it.

An event-run workspace (`creationSource` `EVENT_AGENT`) reads
`automation.workspaceOrigin`; other workspaces never call it. Its **Runs** tab
is shown while that read is pending or failed (with loading or error states) and
whenever it returns a run; an origin without a retained run removes the tab, as
deleting a scheduled automation does. The panel shows the automation's name, the
run that started the workspace, and a link to the event automation.

<a id="event-activation-controls"></a>

The saved detail has **Enable** and **Pause**, with the Active/Paused words of
scheduled automations: the header reads Active while any trigger listens,
Starting while one is still starting, and Paused otherwise. Both send the loaded
`managementRevision` to [enable and pause](#enable-and-pause). Which buttons
show, and every displayed state, comes from the triggers rather than the
definition flag, because an edit, an expiry or a source reset leaves the
definition enabled with every trigger paused. Each configured trigger reads
Listening (enabled and `ACTIVE`), Starting (`STARTING`), Paused (with
`pausedReasonCode` in words), or Can't run (capability not `SUPPORTED`, with its
`explanation`, as for Slack, schedule, actor filters, GitHub `opened`/`edited`,
and natural-language filters whose provider has not passed the classifier gate).
Source health is shown in words, including the `GITHUB_SOURCE_RESET` and
`GITHUB_BASELINE_REQUIRED` states after a reset and Enable. Enable can take a
few seconds while the server validates; a `PRECONDITION_FAILED` shows its
reasons inline, and a `CONFLICT` keeps the page and offers **Reload
automation**. The detail polls at the management cadence, so Starting moves to
Listening or Paused after the next source poll cycle. Pause states that queued
runs are cancelled, started runs continue, and events while paused never run.
The rail shows "Definition enabled" (with a neutral dot) or Paused, because the
list carries only the definition flag and no trigger state. The editor still
says which edits pause triggers; Enable restarts them after saving.

A GitHub source in `RECOVERY_REQUIRED` shows one **Reset source** callout per
connection. Its `ConfirmDialog` says that events from the gap will not run, that
every automation on the source is paused (including other projects) with queued
runs cancelled, and that each automation needs Enable again; a failure stays in
the dialog. Success reports the paused-trigger and cancelled-run counts and
invalidates every cached automation read, list and history in every project,
because the reset reaches other projects on the same source. Enable, Pause and
Reset source are disabled in archived projects. Recovery controls and deletion
belong to separate cuts. Scheduled CRUD and history retain their existing
behavior. Exact-context operator recovery uses the separate trusted-local
transport described in
[agent runtime](agent-runtime.md#exact-context-operator-recovery-transport).
Production authoring still creates paused definitions. Manually altered
ACTIVE-looking legacy records without known membership or a current validated
intent never target, evaluate, admit or claim. Trusted-local HTTP uses existing
locality/origin/forwarding checks, not authenticated human-versus-agent
isolation. The MCP catalog still exposes only source discovery/proposal
authoring/read tools.

### Conversational creation

Workspace sessions expose `list_automation_sources`, `propose_automation`, and
`get_automation_proposal` through their existing MCP server. The workspace agent
interprets the user's request, discovers resource IDs, and proposes a structured
configuration. Slack discovery lists bot-member public/private channels with
pagination. GitHub discovery resolves the current project's repository and
labels through the authenticated `gh` CLI; its connection identity is
repository-scoped (`gh:<repository-id>`), not a GitHub App installation or an
event subscription. Missing GitHub access does not prevent Slack authoring.
Actor-specific ID restrictions are rejected until actor discovery is supported.
The `propose_automation` guidance proposes only the GitHub actions that can be
enabled, `labeled` and `reopened`; GitHub records labels applied when an issue
is created as `labeled` events. It states that `opened` and `edited` are not yet
supported.

`AgentProposal` persists the specification, verified display names, workspace,
revision, and optional created definition. Tool results carry a proposal
reference with type `automation_proposal`; chat loads its current state and
renders an editable card outside the collapsed activity group. Saved chats with
legacy tool names and the `agent_proposal` discriminator still render their
proposal cards. Users can edit instructions, filters, event settings, and
execution settings. **Create automation** atomically creates a paused definition
and its paused triggers. The card says the automation is created paused and is
enabled from the Automations page, and that only GitHub `labeled` and `reopened`
issue triggers can run today. Creation does not start legacy periodic tasks.

Conversational edits use optimistic revision checks and cannot silently replace
a newer proposal. A widget that receives a newer revision refreshes its data;
loading that revision combines conversational changes with local field edits.
Local values take precedence for task/execution fields edited on both sides. If
both sides changed events, loading stops and preserves local edits until the
user explicitly discards them; positional merging could move a filter to a
different source. Creation retries return the existing definition only when the
accepted revision and specification match. Saved configurations remain editable
through **Edit automation** / **Save changes** on the same card; updates
preserve stable event IDs and historical run snapshots, including across removal
and reordering. Removed events are paused, preserving history. The MCP catalog
does not expose commit operations; creation and saved automation updates are
user actions through trusted local API procedures.

Proposals belong to their authoring workspace and are removed with it; created
definitions belong to the project and survive workspace deletion. Deleting a
saved definition also removes its accepted proposal. Logical export/import
recovers definition bodies and supported execution preferences as disabled
records, preserving both revisions and timestamps. It omits connections, event
configuration, proposal provenance, activation and automation execution history.
Ordinary agent inspection can read recovered bodies with no configured events.
The existing explicit complete replacement editor can author fresh events where
project/revision editing rules allow; archived projects and exhausted revisions
retain their restrictions. No timer or event activation authority is restored.

The live authoring evaluation uses the installed Codex ACP runtime, the actual
MCP server and authoring API, a disposable database, and fixed provider
catalogs:

```sh
RUN_AGENT_AUTHORING_EVAL=1 pnpm test src/backend/services/session/service/acp/agent-authoring.manual.integration.test.ts
```

It covers the feedback, packet-unlock, and GitHub-label scenarios, a focused
follow-up edit, and ambiguous workspace clarification. Optional
`AGENT_AUTHORING_EVAL_MODEL` selects a model and `AGENT_AUTHORING_EVAL_OUTPUT`
names an existing directory for transcripts/configurations. These are authoring
evaluations, not classifier recall/precision measurements.

### Natural-language event filters

Deterministic matching runs first; only a deterministic match on a trigger with
`filterInstructions` reaches the classifier, so a filter can narrow but never
widen repository, label or channel scope. The session capsule's
`classifyAgentEvent` makes one disposable structured-output call through the
same isolated path as workspace metadata: a temporary directory, no tools, MCP
servers, hooks, settings, repository instructions or saved session, and the
provider process tree cleaned up. It uses each provider's default small model
from `configService.getAgentEventClassifierConfig()` (Claude `haiku`, Codex
`gpt-6-luna`), separate from the automation's execution settings, with a
30-second limit and at most two concurrent calls. Codex calls use the default
account because no run account exists before admission.

The prompt passes the filter and a bounded projection of the event (issue
title/body, repository, label; Slack text and whether it is a thread reply) as
JSON data marked untrusted. For Slack, evaluation reads the trigger's
[message context](#slack-message-context) before calling the classifier, so a
context failure records its error without spending a classifier call, but the
classifier still judges only the triggering message: adding context to the
prompt is a prompt change that needs a new version and gate run. Actor
identities and links are omitted. Event text that asks to be matched has no
authority. The output schema is strict
`{ decision: 'match' | 'skip' | 'uncertain', reason }`; only `match` admits a
run. Evaluations persist `SEMANTIC_FILTER_*` reason codes and fixed
explanations, never the model's reason text. When a classifier call runs, they
also persist its identity (provider, model, prompt version, input hash);
unproven-provider and unavailable skips and too-long errors have none.
`uncertain` and malformed output are terminal; timeouts, rate limits and
provider failures retry on the evaluation budget. A filter longer than 4,000
characters is never sent to a provider and records a terminal
`SEMANTIC_FILTER_TOO_LONG` error.

Evaluation rechecks the gate for the provider resolved for each event, because
an inherited provider can change after Enable. An unproven effective provider
records a `SEMANTIC_FILTER_PROVIDER_UNPROVEN` skip without calling the
classifier.

The gate is a fixture release gate, not a population accuracy claim. Replay
fixtures (GitHub and Slack, with adversarial injection negatives) live in
`src/backend/services/agent-definition/testing/classifier-fixtures.json`, split
into tuning and held-out cases with obvious positives frozen before tuning. A
provider passes on the held-out set with zero adversarial false positives, every
obvious positive matched, positive recall of at least 90% and at most 10% errors
plus `uncertain` decisions. Results per provider are recorded in
`classifier-gate.json` beside the fixtures and mirrored by
`PROVEN_CLASSIFIER_PROVIDERS`, which a test keeps in agreement with the record,
the current prompt version and the configured models. Changing the prompt or a
classifier model requires a new prompt version and a new gate run. The live run
calls real providers and never runs in CI:

```sh
RUN_AGENT_EVENT_CLASSIFIER_EVAL=1 AGENT_EVENT_CLASSIFIER_EVAL_PROVIDER=CLAUDE pnpm test:integration src/backend/services/session/service/acp/agent-event-classifier.manual.integration.test.ts
```

`AGENT_EVENT_CLASSIFIER_EVAL_PROVIDER` is `CLAUDE` or `CODEX`,
`AGENT_EVENT_CLASSIFIER_EVAL_SPLIT=tuning` scores the tuning set instead of the
held-out set, and `AGENT_EVENT_CLASSIFIER_EVAL_OUTPUT` names an existing
directory for a per-case report.

### Slack credentials

Settings > Integrations > Slack accepts an existing Slack Bot User OAuth Token
(`xoxb-` or a rotating `xoxe.xoxb-` access token). Rotating tokens require
manual renewal when they expire; automatic OAuth refresh is not implemented.
Connect Slack validates it against Slack's `auth.test` endpoint, requires a bot
identity and workspace ID, and encrypts the token with the existing AES-256-GCM
encryption service before upserting an `AgentConnection`. Connecting the same
workspace replaces its token without changing the connection ID or trigger
references. Multiple workspaces can be connected.

Slack event intake uses outbound Socket Mode, which needs an app-level token
(`xapp-`, or a rotating `xoxe.xapp-` access token that needs manual renewal;
scope `connections:write`) from the same Slack app as the bot. Each connected
workspace can save one, encrypted in `appCredentialsEncrypted` separately from
the bot token. Saving it first checks the saved bot token with `auth.test` (it
must still identify the connection's workspace), then resolves the bot's app ID
with `bots.info`, which needs the bot's `users:read` scope. The app ID is stored
as `appId`; it is never inferred from the token prefix. The app-level token is
then validated with `apps.connections.open`. Slack's response is only a
single-use Socket Mode URL: it is discarded immediately and never stored,
returned or logged. Slack documents no field that names the token's app, so the
only check is the `app_id` that Slack currently embeds in that URL: a mismatch
rejects the token, and an absent value is accepted. The Socket Mode listener
must still require the `hello` message's `connection_info.app_id` and each
event's `api_app_id` and `team_id` to match the connection. App-level tokens
belong to an app rather than a workspace, so the workspace match comes from the
bot token. A save is discarded if the bot credential changed while it was being
validated. Reconnecting the same workspace with a replacement bot token keeps
the saved app-level token only when `bots.info` confirms the new bot belongs to
the stored app; a different app, or a failed lookup, clears the app-level token
and app ID. Test connection also reports a mismatch between the bot's current
app and the stored app ID.

The trusted-local `slack` tRPC router supports list, connect, test, disconnect,
`setAppToken` and `clearAppToken`. Its summaries expose workspace name/ID,
enabled state, bot and app-level credential presence (`hasCredentials`,
`hasAppToken`) and `appId`; neither plaintext nor encrypted tokens cross read
responses. Summary reads compute credential presence without loading ciphertext.
Only the internal credential lookups load tokens for decryption;
`getAppCredentials(connectionId)` returns the app-level token, app ID and
workspace ID for the Socket Mode listener, or null unless the connection is
enabled with both tokens. Provider responses are Zod-validated, each outbound
call has a ten-second timeout, redirects are rejected, and provider/transport
errors are sanitized rather than echoed. Disconnect clears both tokens and the
app ID and disables the connection while retaining its identity and trigger
references. Removing only the app-level token keeps the bot connection. Neither
revokes tokens in Slack.

The UI masks token entry, keeps it out of browser persistence, and clears it
after a successful save. Existing tokens are never prefilled; replacing an
app-level token opens an empty field. Test connection uses the stored bot token
and verifies its workspace identity; when an app-level token is saved, it also
re-resolves the bot's app and validates the app-level token. No signing secret
is needed. Saving credentials does not enable event subscriptions, change an
existing Slack app's webhook, or start automations.

Slack intake is gated by `AGENT_SLACK_INTAKE_ENABLED`, read through
`configService.getAgentRuntimeLimits().slackIntakeEnabled`. It is off unless set
to exactly `true`, and stays off until a live check against a dedicated Slack
test app passes. The [Socket Mode listener](#slack-listener) exists behind that
gate, but nothing can yet move a Slack trigger to `STARTING` or `ACTIVE`:
activation by test message is separate work, so Slack triggers keep reporting
`SLACK_INTAKE_UNAVAILABLE`.

These credentials depend on the server's `encryption.key`; retain it with any
database-file backup. Logical export/import includes Slack connection identity,
name, source enabled state and timestamps, but not the app-level token or app
ID. Recovery restores new identities disabled with no tokens; existing
connection IDs or Slack workspace identities are skipped without updates.
Reconnect manually in Slack settings using a new bot token, then add the
app-level token again. GitHub connections, connection bindings, event
configuration and automation execution history remain excluded; tokens and
encryption keys never appear in logical exports.

### Slack listener

The listener holds one outbound Socket Mode connection per eligible Slack
connection, using the official `@slack/socket-mode` client (pinned in
`package.json`) behind a narrow adapter, `SlackEventSource` in the
agent-definition capsule. A connection is eligible only while the intake gate is
on, the connection is enabled with both tokens and an app ID, and at least one
configured Slack trigger on a non-archived project is `STARTING`, or `ACTIVE`
with its trigger and definition enabled, and those triggers select at least one
channel in valid configuration. Nothing is opened otherwise.

The Slack app needs:

- Socket Mode turned on, and an app-level token with `connections:write` saved
  in Settings > Integrations > Slack.
- Event Subscriptions turned on with the bot events `message.channels` (public
  channels, bot scope `channels:history`) and `message.groups` (private
  channels, bot scope `groups:history`). Request URLs are not used.
- Bot scopes `users:read` (to confirm the app when the app-level token is saved)
  and `channels:read`/`groups:read` (channel discovery), and the bot invited to
  every selected channel.
- To be dedicated to this connection. Socket Mode spreads an app's events across
  all of its open connections, so another listener on the same app (or the same
  app connected for a second workspace here) would receive some of the events.
  Two eligible connections with one app ID are both refused with
  `SLACK_APP_SHARED`.

Identity fails closed. The socket's `hello` frame must carry
`connection_info.app_id` equal to the stored app ID, and every `events_api`
envelope must carry the stored `api_app_id` and `team_id`. A mismatch stores
nothing, leaves the envelope unacknowledged, closes the socket and records
source health `ERROR` (`SLACK_APP_MISMATCH` or `SLACK_WORKSPACE_MISMATCH`); the
listener does not reconnect until the stored credentials change or the
application restarts.

Only human messages enter the ledger: `message` events without a bot identity,
both channel roots and thread replies, in a channel selected by a listening
trigger on that connection, either without a subtype or with one of two subtypes
a person's message carries: `file_share` (the message includes a file or
screenshot) and `thread_broadcast` (a thread reply also sent to the channel).
Those two are stored like ordinary messages, text only, with `subtype` recorded;
files and attachments are never stored or fetched, and the starting prompt says
that files were not included. The deterministic matcher accepts the same three
forms. Each message is stored through `ingestEvent` with identity
`(connectionId, event_id)` and acknowledged only after the insert commits; a
duplicate insert is acknowledged too. If the insert fails, the envelope stays
unacknowledged so Slack can redeliver it. Bot messages (including bot file
shares), hidden messages, edits, deletes, every other subtype, other event
types, messages in unselected channels, malformed messages and non-`events_api`
envelopes are acknowledged and not stored. Text longer than the
100,000-character payload limit is cut with a visible truncation marker. Message
text is never logged.

Source health is `READY` (with `isReady`) once a verified socket says hello. An
unexpected close, a failed or timed-out connection attempt (30 seconds), a
credential change and listener shutdown open a delivery gap `{ from, to: null }`
in the Slack cursor and mark the source `DISCONNECTED` or `ERROR` with a reason
code; the next verified connection closes the gap. A process that exits without
recording its stop leaves `READY` behind; the next start opens a gap from the
last time that listener was known to be connected (`lastObservedAt`, refreshed
about once a minute). When the listener stops on purpose (gate turned off, no
listening trigger left, app-level token missing) it records `DISCONNECTED`
without a gap and closes any open one. The cursor keeps the latest 100 gaps.
Slack may redeliver unacknowledged events, but its documentation says events can
be lost while no connection is open, so a gap means events may have been missed;
nothing recovers them automatically. `RECOVERY_REQUIRED` health is never
overwritten.

The SDK's own reconnection and HTTP retries are turned off: its reconnect path
can reject outside any caller, which is fatal in this backend, and its retries
outlive `disconnect()`. Reconnection is instead the `agent-slack-intake`
reconciliation described in
[background jobs](background-jobs.md#timer-dispatch-ownership), with backoff
from 5 seconds to 5 minutes after failed attempts. A socket that finishes
connecting after the listener closed it is closed again and its events are not
acknowledged. The SDK's logger is replaced with one that drops debug and info
output and reduces warnings and errors to fixed category codes, so tokens,
ticketed socket URLs and message bodies are never logged.

### Slack message context

A Slack trigger's `context` (`includeThread`, default on, and
`nearbyMessageCount`, 0 to 100) decides what conversation the run sees besides
the triggering message. Evaluation reads it once the event has matched
deterministically and its execution settings resolved, before any
natural-language filter, through the `resolveSlackContext` evaluation port. Root
messages with only `includeThread` and replies with neither option need no Slack
call.

- With `includeThread`, a thread reply (including a `thread_broadcast`) reads
  its thread with `conversations.replies`: the thread start and the replies
  before the triggering message, oldest first, following cursors for at most
  five pages of 200 replies.
- With `nearbyMessageCount`, the channel's messages just before the triggering
  message are read with `conversations.history` (newest first, paging until the
  count is met, at most five pages), skipping messages already in the thread.
- Only the triggering message's channel is read, and only when the trigger
  selects it; nothing after the triggering message is read. Joins, topic
  changes, edits and other system messages are not context. Bot messages are,
  labelled as bot.

Both reads use the connection's bot token through the internal credential lookup
and `callSlackApi` (ten-second limit combined with the evaluation's abort
signal, no redirects, Zod-validated pages, sanitized errors). The token never
reaches logs, errors, evaluations, run snapshots or the event ledger, and the
connection must still belong to the event's workspace. The scopes are the
listener's history scopes: `channels:history` for public channels and
`groups:history` for private channels, with the bot in the channel. Slack lists
both methods as Tier 3 for internal apps; Slack's May 2025 limits for
commercially distributed non-Marketplace apps (one request a minute, 15
messages) would make context reads fail as rate limited.

Context is capped at 100 messages and 100,000 characters in total. The budget
goes nearest the triggering message first: the thread start, then replies newest
first, then channel messages newest first. Each section drops only its oldest
messages and says so in a marker such as
`[51 earlier replies omitted: Slack context is capped at 100 messages and 100,000 characters.]`.
A message longer than 10,000 characters is shortened with `[message shortened]`,
and a thread longer than the page limit ends with a marker saying later replies
were not read.

The run input lists, in order: a `<eventId>:source` item naming the triggering
message (channel, author, time, thread, files not included, link) and saying its
text follows; `<eventId>:message`, the message text; `<eventId>:thread`, the
thread section; and `<eventId>:channel`, the channel section. Each section
starts by saying it is context only, not the request, then gives each message as
`Reply from person U123 at <time>:` (or `Thread start from`, `From`, `bot`, and
`(files not included)`) followed by its text with every line quoted with `> `,
so context text cannot pose as a label or as the triggering message. The
starting prompt already calls all of it task data, not authority.

Failures never start a run with partial context. Rate limits (honoring
`Retry-After`), unreachable Slack and Slack server errors record a retryable
`ERROR` (`SLACK_CONTEXT_RATE_LIMITED` or `SLACK_CONTEXT_RETRY`) on the shared
evaluation retry budget. A missing history scope (`SLACK_CONTEXT_MISSING_SCOPE`,
naming both scopes), a channel or thread the bot cannot read
(`SLACK_CONTEXT_CHANNEL_UNAVAILABLE`), a missing, rejected or other-workspace
bot token (`SLACK_CONTEXT_NOT_CONNECTED`), an unexpected Slack response
(`SLACK_CONTEXT_FAILED`), an unselected channel (`SLACK_CONTEXT_NOT_SELECTED`)
or an unwired port (`SLACK_CONTEXT_UNAVAILABLE`) is a terminal `ERROR`.

## Client query transport

The browser streams completed tRPC queries within each HTTP batch so a slow read
does not hold up independent results. Mutations retain ordinary HTTP batching,
including support for response headers and cookies. Both transports use the same
relative `/api/trpc` URL, default same-origin credentials and SuperJSON.

The Express adapter and authenticated HTTP proxy pass incremental query chunks
through. An external proxy configured to buffer responses can still delay
results until the batch finishes; disable response buffering for `/api/trpc`
when configuring such a proxy. Procedure errors remain independent within a
batch.
