# Batched PR Discovery Design

## Problem

The scheduler currently selects every READY workspace that has a branch and no attached pull request every three minutes. It then runs one uncached `gh pr list --head` process per workspace. A branch that never gets a pull request therefore consumes GitHub CLI and API capacity forever, and many workspaces in the same repository repeat the same repository lookup.

## Considered Approaches

1. Persist a due time per workspace and batch each due pass by repository. This is the recommended approach because retry eligibility is workspace-specific, repository lookups are shared, and the schedule survives process restarts.
2. Persist one schedule per repository. This minimizes scheduling rows, but one inactive workspace would slow discovery for a newly active workspace in the same repository unless a second workspace-level activity index were introduced.
3. Cache per-branch misses in memory. This is smaller initially, but restarts erase the backoff, multiple server processes cannot share it, and terminal workspaces remain difficult to exclude efficiently.

## Data Model and Due Query

Add three nullable/defaulted fields to `Workspace`:

- `prDiscoveryLastCheckedAt DateTime?`
- `prDiscoveryRetryCount Int @default(0)`
- `prDiscoveryNextCheckAt DateTime?`

Add a composite index on `(status, prUrl, prDiscoveryNextCheckAt)`. The due query selects only READY workspaces with no PR URL, a branch name, complete GitHub owner/repository metadata, and either no next-check time or a next-check time at or before the pass timestamp. It orders never-checked/reset candidates first, then recent workspace activity, and applies the configured candidate limit before returning project data.

ARCHIVING, ARCHIVED, FAILED, and otherwise non-READY workspaces are not eligible. Attaching a PR makes a workspace ineligible through `prUrl`, without requiring a separate terminal flag.

## Backoff and Activity Resets

Before repository I/O begins, each selected candidate is conditionally claimed using its observed branch, activity timestamp, retry count, and next-check time. A successful claim increments the retry count and schedules exponential retry delays of 3, 6, 12, 24, and so on up to six hours. A symmetric 20% jitter is applied and the final delay is clamped to six hours. Claim-before-I/O gives crash safety and makes repository lookup or PR attachment failures use the same bounded schedule, so an unavailable repository cannot be hammered every scheduler tick. If concurrent workspace activity or a branch/status/PR change wins the conditional update, that candidate is skipped and its newer state remains authoritative.

Relevant activity atomically resets the retry count and next-check time, making the workspace due again:

- session completion uses the existing session-end fallback hook;
- a successfully completed `git push` resets, including pushes that do not rename a branch;
- persisted branch renames reset in the same workspace update;
- an explicit PR status refresh with no attached PR resets discovery eligibility.

The scheduler interval remains three minutes. Therefore an activity reset is observed within at most one scheduler interval (three minutes) when the configured per-tick limits have capacity. Reset candidates sort ahead of backed-off candidates, so recent activity receives priority when a backlog exists. The candidate and repository limits are configurable through `PR_DISCOVERY_CANDIDATE_LIMIT` (default 100) and `PR_DISCOVERY_REPOSITORY_LIMIT` (default 10).

## Repository Batching and Matching

For each selected repository, run exactly one:

```text
gh pr list --repo owner/repo --state open --json number,url,createdAt,headRefName --limit 1000
```

Match the returned PRs locally by exact `headRefName`. Retain the existing collision guard: a PR created before a workspace is ignored for that workspace. Repository names form the batch key, so identical branch names in different repositories never collide. If one repository fails, log it, retain the already-claimed retry metadata for only that repository's candidates, and continue processing other repositories.

The scheduler continues to use its existing whole-tick in-flight promise, so PR status synchronization and PR discovery from one tick finish before another tick starts. Candidate and repository limits bound each tick independently.

## Error Handling and Observability

The repository listing API throws on CLI, authentication, network, rate-limit, or JSON-validation failure so the scheduler can distinguish failure from a successful empty result. Discovery logs record candidate count, selected repository count, checked workspaces, discoveries, and repository failures. PR snapshot attachment remains the canonical write path; `fetch_failed` still counts as discovered because the URL was attached.

## Testing

Tests cover:

- exponential progression, jitter bounds, and the six-hour cap;
- the indexed due query, terminal-state exclusion, ordering, and candidate cap;
- environment-configured candidate and repository limits;
- one CLI invocation per repository and exact local branch matching;
- repository failure isolation and retry scheduling;
- same branch names across repositories and PRs predating a workspace;
- discovery and attachment of a newly opened PR;
- session completion, push, branch rename, and explicit-refresh resets;
- the existing non-overlapping scheduler tick behavior.

No UI behavior changes, so screenshots are not applicable.
