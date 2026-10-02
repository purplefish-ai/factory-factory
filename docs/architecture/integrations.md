# Integrations

## GitHub

GitHub URL imports use the shared `parseGithubUrl` validator for both the New
Project form and backend input validation. Invalid owner/repository segments
show an inline error and cannot be submitted; supported HTTP, HTTPS, and SSH
URLs keep the existing `.git` suffix and trailing-slash behavior.

Uses the local `gh` CLI's auth — there is no stored GitHub token. Issue fetch
supports the workspace issue picker (`listIssuesForWorkspace`) and Kanban intake
(`listIssuesForProject`, assigned to `@me`). Starting from an issue creates a
linked workspace (`githubIssueNumber`, `githubIssueUrl`).

GitHub project imports reuse existing clone directories when owner or repository
casing differs, preserving the existing path and local changes. New clones use
lowercase owner/repository paths, matching GitHub's case-insensitive names. URL
validation and the existing non-repository directory guard still apply.

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

Check-run conclusions preserve `STARTUP_FAILURE` through PR-detail mapping, so
both PR sync and Ratchet classify startup failures as failing CI, including when
other checks are still running. Sidebar and Kanban projections therefore agree
on the cached CI status.

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
user's browser timezone (`scheduledTime` HH:MM + IANA `timezone` fields).

Each execution runs the configured prompt, monitors for PR creation, and
advances the schedule. Concurrent runs are skipped.

Managed via the "Periodic Tasks" admin tab and created from the Kanban launch
dropdown. The workspace right panel shows execution history for
periodic-task-sourced workspaces.

Service capsule: `src/backend/services/periodic-task/`.

Distinct from the wake schedule (see
[agent-runtime.md](./agent-runtime.md#wake-schedule)): periodic tasks always
spawn a fresh workspace and are configured from the Admin UI, while a wake
schedule resumes the _same_ workspace's own session and is configured by the
agent itself mid-session via MCP tools.
