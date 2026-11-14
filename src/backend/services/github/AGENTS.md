# GitHub capsule

Every GitHub read and write the backend makes, through the local `gh` CLI, and
the PR facts built from them: normalized observations, check facts, review facts
and PR association refreshes. The [services guide](../AGENTS.md) covers capsule
layout and boundaries. `index.ts` and paths that start with `service/` are
relative to this directory, other bare file names are under `service/`, and
paths that start with `src/` are from the repository root.

## Owns, and does not own

This capsule owns the `gh` process budget (one limit of five processes, read
singleflight, rate-limit and connectivity fast-fail), the `gh` health and
authentication checks, issue and pull request reads, review submission and
comments, review-request search and its cache, the normalized `PRObservation`,
and attach, detach and refresh of a workspace's PR associations. Authentication
is the local `gh` login; no GitHub token is stored. It owns no Prisma model. It
does not own:

- PR rows and their writes: the workspace capsule's `workspacePrSnapshotService`
  (`src/backend/services/workspace/`), reached through `GitHubWorkspaceBridge`.
- When to observe, observation pacing and PR update delivery:
  `src/backend/orchestration/pull-requests/`, which injects the observer.
- Which observations become PR events: `src/shared/pr-trigger-policy.ts`.
- Wiring of this capsule's bridges: `configureDomainBridges` in
  `src/backend/orchestration/domain-bridges.orchestrator.ts`.
- GitHub URL parsing for project imports: `src/shared/github-url.ts`; cloning:
  `src/backend/services/workspace/service/worktree/git-clone.service.ts`.
- The aggregate CLI health cache across Claude, Codex and GitHub:
  `src/backend/orchestration/cli-health.service.ts`.
- GitHub sources for event automations, beyond the reads here:
  `src/backend/orchestration/agents/`.

## Public surface

`index.ts`: `githubCLIService`, `checkGithubAuth`, `prObservationService`,
`prSnapshotService` with its `PR_*` events, `prFetchCoordinator`, the
adversarial-review posting functions (`submitCodeReview`, `createReviewComment`,
`getPRDescription`, `getPRHeadCommitSha`) and their `ReviewSubmissionError`, the
review-activity helpers and `classifyGitHubCLIError`.

## Invariants

- The CLI service, `checkGithubAuth`, `submitCodeReview` and `getPRDescription`
  share one limit of five concurrent `gh` processes (`ghExecLimit`).
  `github-cli-process-limit.test.ts`.
- In `githubCLIService`, identical concurrent reads without an abort signal
  share one process, while writes and signal-bound reads always spawn their own.
  `github-cli.service.test.ts`, `github-cli-pr-details.test.ts`.
- After a rate-limit failure `githubCLIService` reads fail without spawning
  `gh`, including reads already queued for a process slot; after a connectivity
  failure its network reads fail for 30 seconds, queued ones too, while its
  authentication checks and writes still run.
  `github-cli-status-details.test.ts`, `github-cli-network-backoff.test.ts`.
- A wrapped `gh` failure keeps the original error as `cause`, never repeats the
  command line, and is classified by `gh`'s diagnostic rather than by its
  arguments. `service/github-cli/errors.test.ts`.
- `checkGithubAuth` reports authenticated only for a zero exit with a login line
  and no login failure on either output stream.
  `service/github-cli/auth-check.test.ts`.
- A forced health check waits for older refreshes, so a result started before a
  login cannot replace it. `github-cli-health-cache.test.ts`.
- With reviews requested an observation reads core facts and conversation
  comments in one `gh pr view` (with `includeReviews: false`, core facts only),
  and if that read fails for any reason but an abort or a connectivity failure,
  it falls back to the core read and reports reviews incomplete.
  `pr-observation.service.test.ts`.
- Full PR detail reads accept up to 10 MiB of output and fail beyond it rather
  than return truncated metadata. `github-cli-full-details-buffer.test.ts`.
- A PR refresh writes nothing itself: it runs the injected observation and then
  returns the association's committed fields. `pr-snapshot.service.test.ts`,
  `pr-snapshot-collection.service.test.ts`.

## Map

- `github-cli.service.ts`: `githubCLIService`, the facade for issue, pull
  request, review, comment and repository reads and writes, its health cache and
  its issue and review-request caches. `checkGithubAuth` and the
  adversarial-review functions spawn `gh` from their own modules.
- `service/github-cli/executor.ts`: process budget, singleflight and fast-fail;
  `service/github-cli/constants.ts`: the limit, timeouts and output buffers.
- `service/github-cli/errors.ts`: classification and wrapping of `gh` failures.
- `service/github-cli/auth-check.ts`: the New Project authentication badge's
  check.
- `service/github-cli/pr-details.ts`, `reviews.ts`,
  `resolved-review-comments.ts`, `mappers.ts`, `schemas.ts`: PR reads and their
  validation.
- `service/github-cli/review-requests.ts`, `review-request-cache.ts`:
  review-request search.
- `service/github-cli/issue-search.ts`, `agent-sources.ts`,
  `agent-issue-events.ts`: issue search and the repository and issue reads event
  automations use.
- `service/github-cli/code-review.ts`: posting adversarial-review findings.
- `pr-observation.service.ts`: one normalized observation of an attached PR;
  `github-check-facts.ts` and `pr-review-facts.ts` build its check and review
  facts.
- `pr-snapshot.service.ts`: attach, detach and refresh of PR associations;
  `bridges.ts` declares the workspace capabilities it is given.
- `pr-fetch-coordinator.ts`: skips a background PR fetch that another caller is
  running or just finished.
- `pr-actionable-review.ts`: review activity for prompts.

## Decisions

- [Review-request and gh health caching](../../../../docs/decisions/2026-11-13-review-request-and-gh-health-caching.md)
- [Core-only observation while monitoring is off](../../../../docs/decisions/2026-11-13-core-only-pr-observation-while-monitoring-is-off.md)
