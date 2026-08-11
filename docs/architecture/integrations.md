# Integrations

## GitHub

Uses the local `gh` CLI's auth — there is no stored GitHub token. Issue fetch
supports the workspace issue picker (`listIssuesForWorkspace`) and Kanban intake
(`listIssuesForProject`, assigned to `@me`). Starting from an issue creates a
linked workspace (`githubIssueNumber`, `githubIssueUrl`).

All `gh` spawns go through `GitHubCLIService`, which owns the process-wide
concurrency limit, the fast-fail on rate limiting, and singleflight dedup of
identical in-flight reads. Do not spawn `gh` directly from a service. See
[pull-requests.md](./pull-requests.md) for how the ratchet and the PR sync poll
share that budget.

## Linear

A per-project issue provider can be set to Linear with an encrypted API key plus
team selection. Kanban intake uses Linear issues assigned to the configured
viewer. Starting from an issue creates a linked workspace (`linearIssueId`,
`linearIssueIdentifier`, `linearIssueUrl`), and workspace lifecycle events
best-effort sync issue state back to Linear.

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
