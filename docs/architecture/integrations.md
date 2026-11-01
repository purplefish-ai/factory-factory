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

Monitoring's `getPRStatusDetails` reads only PR/head/check metadata. Optional
`getPRReviewDetails`, review comments and resolved threads share the existing
CLI budget but cannot block core observations when enrichment fails. Review
facts then remain explicitly incomplete, preserving earlier feedback until a
complete read or confirmed resolved IDs supersede it. Abort and core-fetch
failures still fail the observation. `getPRFullDetails` retains its full
detail-view contract. No extra polling loop is introduced.

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
subscriptions and admits association-aware effects only for accepted PR
invalidations. Removing a workspace or stopping the collector clears completion
tracking; already admitted Linear work may still complete after cleanup.

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

## Scheduled agents

<a id="periodic-tasks"></a>

Agents are recurring instructions that create a fresh workspace on a configured
cadence (daily, weekly, monthly, or testing cadences every minute / five
minutes). Daily/weekly/monthly tasks can optionally run at a specific time of
day in the user's browser timezone (`scheduledTime` HH:MM + IANA `timezone`
fields). Daily and weekly periodic tasks with a scheduled time advance calendar
dates in the task timezone, preserving the scheduled day across daylight saving
changes.

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
- **Failed** when a session records a provider error, the 4-hour turn timeout,
  or an unexpected process exit. The run uses that session message as its error
  and does not wait for the five-minute window. Deliberate stops are not
  failures. A run also fails when workspace setup or launch fails, or when no
  agent session ever started its provider, because the agent never ran.

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
execution ID as its correlation identity. Composition wires its narrow timer
dispatch port to the `new_workspace` arm of
`background-action-dispatch.orchestrator.ts`, shared with PR delivery's
`existing_sessions` arm. Timer dispatch awaits the injected workspace launcher
and returns the workspace ID; the periodic capsule owns linkage, failures and
completion monitoring.

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

Manage agents at `/projects/:slug/agents` or open an individual definition at
`/projects/:slug/agents/:id`. The navbar project selector is the shared project
context; Agents has no separate project filter. Agents and project-wide Reviews
remain in the sidebar footer above global Settings. Settings links to Agents
without a duplicate editor. Project switches preserve the current section and
clear the selected definition. Legacy `/agents` and `/agents/:id` links resolve
the definition's owner before trusting a stored project selection, including
archived owners. A definition belonging to another project or an invalid ID
shows project-local not found instead of selecting another agent.

The Agents footer badge counts all definitions in the URL owner's project,
including paused definitions and archived project owners. It warns when any
agent's latest completed outcome is FAILED. RUNNING and SKIPPED retries retain
that warning until the same agent completes a run or creates a PR. The summary
query selects the latest terminal outcome by start time, then ID, independently
of history limits. It refreshes with management's 10-second cadence and after
definition changes. Unknown/loading projects hide the badge; loaded empty
projects show zero. A failed refresh retains the last successful count for that
project.

Agents stacks its rail and editor below 48rem of available content width,
including when the workspace sidebar is expanded. Schedule fields share a row
only above 26rem of their own available width. Resizing preserves form drafts.

Create/edit use Name, Instructions and Schedule. Creation makes the first run
due immediately; the existing periodic-task poll admits it, then follows the
configured schedule. No new timer or admission policy is introduced. An
unchanged clock time keeps an edited agent's timezone; changing the time uses
the browser timezone. Clearing the time or switching to a minute cadence clears
both schedule fields. Kanban's **Create Agent** launch mode keeps its
instructions composer and uses the same schedule controls. It remains available
while chat provider defaults load. No provider or unattended-execution policy
changes accompany this UI.

Pause affects future runs; an already running workspace continues. Deleting an
agent requires confirmation and removes its definition and execution history,
while existing workspaces and conversations remain available. Failed requests
show an error and preserve form drafts. The management page polls task/history
data without replacing unsaved edits.

Both the management page and the workspace's **Agent** origin panel use the
shared run history query, showing up to 50 recent runs with status, start time,
workspace/PR links and errors. Workspace links use the agent owner's slug and
remain available for non-null IDs, including archived workspaces. A running run
without a workspace ID says no workspace yet; a terminal run without one says
workspace unavailable. The origin panel links back to agent management.

The workspace's provider sub-agent/child-workspace tab is **Sessions**. Stored
panel keys remain `agents` for Sessions and `periodic-task` for Agent. Once
workspace data loads, an unavailable origin tab falls back to Changes, as does a
retired auto-iteration preference. Deleting a definition therefore cannot leave
that panel blank.

Service capsule: `src/backend/services/periodic-task/`.

## Event-triggered agent data model

The agent-centered persistence foundation lives in `AgentDefinition`,
`AgentConnection`, `AgentTrigger`, `AgentRun`, and `AgentProposal`, owned by the
`agent-definition` capsule. It is additive: existing `PeriodicTask` definitions,
executions, polling, and UI remain authoritative for scheduled agents. No
definitions are copied into the new tables. Migrating the scheduler is a
separate change.

- A project owns agent definitions. Each definition stores task instructions,
  versioned execution configuration, and an enabled flag. Definitions have no
  mandatory schedule and default to paused. Explicit model or reasoning-effort
  settings require a provider; model compatibility uses the same shared
  normalization as interactive session launch.
- Connections identify reusable Slack workspaces or GitHub installations, unique
  by provider and external ID. Optional credentials belong in
  `credentialsEncrypted`, using the existing encryption service; never put
  credentials in trigger configuration or run snapshots. Public connection APIs
  return only metadata and credential presence.
- A definition owns any number of independently enabled triggers. Schedule,
  Slack-message, and GitHub-issue triggers retain the user's natural-language
  `description` alongside resolved, versioned `config`. Optional
  `filterInstructions` are separate from the agent's task instructions. Triggers
  default to paused. Future admission must check the definition, trigger,
  connection, and project state.
- Runs have an agent-scoped unique `idempotencyKey`, optional trigger and
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
keys within an agent, and runs referencing another agent's trigger. A connection
with configured triggers cannot be deleted. A trigger with run history must be
paused rather than deleted. Deleting a definition cascades its triggers and run
history but retains its workspaces. Deleting a workspace clears its run link
without deleting run history. Editing definitions or triggers does not rewrite
stored snapshots; future run writers must keep them immutable.

The agent-definition capsule also owns the durable event runtime foundation:
`AgentSourceState`, `AgentEvent`, `AgentEvaluation` and `AgentInitialDelivery`.
Its barrel exports `ingestEvent`, `finalizeEventOrder`, `recordEvaluation`,
`admitRun` and `claimNextRun`. These are persistence primitives; no activation
API, launch worker or automatic execution starts from them.

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
`GitHubCLIService` budget. Only `labeled` issue events enter the executable
ledger; PRs and other actions retain only their feed identities as control
anchors. The configured project path must resolve to the connection's numeric
repository identity on each cycle, including after repository renames. Paused
authoring remains inert: only active triggers or explicit starting activations
on non-archived projects are source targets.

Runtime composition resolves GitHub reads and page limits from the owning
application graph. Incomplete project paths are omitted from a shared source; if
no complete path remains, the source is unavailable. Complete paths resolving to
a different repository identity still require recovery.

`AgentSourcePage` retains immutable page identities, captured event references,
and completed interval high water. Capture, event insertion and continuation
commit in one transaction. Capture and a second ordered verification traversal
share the ten-page cycle budget, resume with persisted overlap, and keep the
original head fixed. When new head events move a resumed verification overlap,
verification rechecks from the fixed head rather than ignoring unknown middle
items. These reads share the same cycle budget. New head events wait for the
next interval. Missing anchors or observed sequence changes stop intake with
`RECOVERY_REQUIRED`; no cursor is silently reset. Recovery health and its
original reason remain a durable fence: normal failures, baseline preparation
and late page/chunk writes cannot clear or advance it. GitHub's offset pages are
not a snapshot, so these checks detect observed discontinuity rather than
guarantee lossless capture under arbitrary provider deletion or reordering.
Finalization requires verified durable scan evidence and commits each
oldest-first chunk with its progress before another interval can start.

`AgentSourcePollService.prepareBaseline(connectionId, signal)` requires an
active or starting source and returns a baseline ID plus a nullable boundary. An
initial baseline saves the actual head (or empty marker) without backfilling
historical events. An already-polled source retains a prepared head in
`AgentSourceBaseline` until all older events have canonical ordinals;
`getBaseline(connectionId, id)` reads that result. A non-executable head can
have ordinal zero. Retained completed-interval evidence also resolves
preparation that races a newer commit, even after event rows are pruned. These
methods do not enable any trigger; trusted activation and its
revision/generation checks remain separate work. Source page and baseline
retention cleanup is likewise a separate worker.

Defaults are one active run per definition, four globally, 100 waiting runs per
definition and 24-hour waiting expiry. The first three limits are configurable
through `AGENT_ACTIVE_PER_DEFINITION`, `AGENT_ACTIVE_GLOBAL` and
`AGENT_WAITING_PER_DEFINITION`. Queue overflow and expiry produce durable
reasons. Instruction/execution edits advance the definition revision, pause
triggers and cancel unclaimed runs. Trigger edits do the same for that trigger;
cosmetic name edits preserve activation. Work claimed before an edit keeps its
frozen settings.

The ledger records 30-day text/evaluation and 90-day identity retention
boundaries. Automatic admission rejects events older than 30 days even if they
are newly observed. Cleanup workers are a separate implementation step. Frozen
run input and provider conversations have separate lifetimes, so ledger pruning
does not erase all source text. Compact run results and PR links survive
workspace and event deletion. Logical export/import still excludes the agent
tables and credentials; the complete supported backup is the database file
together with `encryption.key`.

### Conversational creation

Workspace sessions expose `list_agent_sources`, `propose_agent`, and
`get_agent_proposal` through their existing MCP server. The workspace agent
interprets the user's request, discovers resource IDs, and proposes a structured
configuration. Slack discovery lists bot-member public/private channels with
pagination. GitHub discovery resolves the current project's repository and
labels through the authenticated `gh` CLI; its connection identity is
repository-scoped (`gh:<repository-id>`), not a GitHub App installation or an
event subscription. Missing GitHub access does not prevent Slack authoring.
Actor-specific ID restrictions are rejected until actor discovery is supported.

`AgentProposal` persists the specification, verified display names, workspace,
revision, and optional created definition. Tool results carry a proposal
reference; chat loads its current state and renders an editable card outside the
collapsed activity group. Users can edit instructions, filters, event settings,
and execution settings. **Create agent** atomically creates a paused definition
and its paused triggers. The card explicitly says that listening and automatic
runs are not yet available. Creation does not start legacy periodic tasks.

Conversational edits use optimistic revision checks and cannot silently replace
a newer proposal. A widget that receives a newer revision refreshes its data;
loading that revision combines conversational changes with local field edits.
Local values take precedence for task/execution fields edited on both sides. If
both sides changed events, loading stops and preserves local edits until the
user explicitly discards them; positional merging could move a filter to a
different source. Creation retries return the existing definition only when the
accepted revision and specification match. Saved configurations remain editable
through **Edit agent** / **Save changes** on the same card; updates preserve
stable event IDs and historical run snapshots, including across removal and
reordering. Removed events are paused, preserving history. The MCP catalog does
not expose commit operations; creation and saved-agent updates are user actions
through trusted local API procedures.

Proposals belong to their authoring workspace and are removed with it; created
definitions belong to the project and survive workspace deletion. Deleting a
saved definition also removes its accepted proposal. Logical export/import does
not include proposals or the other new agent tables.

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
evaluations, not classifier recall/precision measurements: event matching and
classification require their own replay evaluation when the runtime is built.

### Slack credentials

Settings > General Settings > Slack accepts an existing Slack Bot User OAuth
Token (`xoxb-` or a rotating `xoxe.xoxb-` access token). Rotating tokens require
manual renewal when they expire; automatic OAuth refresh is not implemented.
Connect Slack validates it against Slack's `auth.test` endpoint, requires a bot
identity and workspace ID, and encrypts the token with the existing AES-256-GCM
encryption service before upserting an `AgentConnection`. Connecting the same
workspace replaces its token without changing the connection ID or trigger
references. Multiple workspaces can be connected.

The trusted-local `slack` tRPC router supports list, connect, test and
disconnect. Its summaries expose workspace name/ID, enabled state and credential
presence; neither plaintext nor encrypted tokens cross read responses. List
reads compute credential presence without loading ciphertext. Only the internal
credential lookup loads the token for decryption. Provider responses are
Zod-validated, outbound validation has a ten-second timeout, redirects are
rejected, and provider/transport errors are sanitized rather than echoed.
Disconnect clears credentials and disables the connection while retaining its
identity and trigger references. It does not revoke the Slack token.

The UI masks token entry, keeps it out of browser persistence, and clears it
after a successful save. Existing tokens are never prefilled. Test connection
uses the stored token and verifies its workspace identity. No signing secret or
Socket Mode app token is needed for credential validation. Saving a connection
does not enable event subscriptions, change an existing Slack app's webhook, or
start agents. Slack event intake is still a separate implementation step.

These credentials depend on the server's `encryption.key`; retain it with any
database-file backup. Logical export/import does not yet include agent
connections or their credentials.

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
