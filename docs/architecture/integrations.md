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

Cache clearing also supersedes in-flight checks, so late pre-upgrade results
cannot replace the post-upgrade status.

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
more than a full period runs once and resumes one period after that run instead
of replaying the missed slots. Archived projects are excluded from due-task
polling. Their task definitions retain their enabled state and schedule, so
overdue tasks become eligible again when the project is unarchived. The atomic
dispatch reservation rechecks the project state: archiving between the due-task
read and reservation creates no execution and does not advance the schedule. The
workspace insert also checks project archive state atomically if archiving races
an already admitted run.

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
