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
Removing a workspace or stopping the collector clears completion tracking.

Archiving a project returns the same sanitized issue tracker configuration as
project reads and updates: the encrypted key is omitted and replaced with
`hasApiKey`.

API key validation in admin settings clears earlier team choices before each
request. Editing the key requires fresh validation and team selection before
saving. Responses to superseded validations cannot restore earlier team choices.
Failed Linear settings saves retain the validated key and selected team for
retry. Successful saves clear the submitted form only if no key edits, team
changes, or newer validation have superseded the submission.

## Periodic tasks

Scheduled recurring tasks that create a fresh workspace on a configured cadence
(daily, weekly, monthly, or testing cadences every minute / five minutes).
Daily/weekly/monthly tasks can optionally run at a specific time of day in the
user's browser timezone (`scheduledTime` HH:MM + IANA `timezone` fields). Daily
and weekly periodic tasks with a scheduled time advance calendar dates in the
task timezone, preserving the scheduled day across daylight saving changes.

Each execution runs the configured prompt, monitors for PR creation, and
advances the schedule. Concurrent runs are skipped. Default sessions use the
`periodic-task` workflow, so non-interactive Codex startup selects unattended
execution mode and tool approval prompts cannot stall scheduled runs.

The periodic bridge adapts the injected workspace-launch owner's result to a
workspace ID. Its separate policy persists first and requires a `periodic-task`
/ `Periodic task` session, without explicit provider resolution, CLI preflight,
or a capacity gate. Session failure propagates with the workspace retained and
no initialization scheduled. Successful provisioning starts initialization once
in the background. The scheduler reserves the execution and advances the next
run before launch, then records its workspace ID or marks the execution failed.

Managed via the "Periodic Tasks" admin tab and created from the Kanban launch
dropdown. The workspace right panel shows execution history for
periodic-task-sourced workspaces. Once workspace data loads, a stored
right-panel selection falls back to Changes if its periodic task or
auto-iteration mode is no longer available. Deleting a task therefore cannot
leave that panel blank.

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
