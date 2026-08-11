# Pull Request Automation

## Auto-Fix (Ratchet)

Automatically watches pull requests and dispatches agents to fix issues
(1-minute check cadence). When a PR has failing CI or actionable review
feedback, creates a fixer session to address it.

The global review-trigger mode defaults to `CHANGES_REQUESTED`, which includes
changes-requested review bodies and unresolved inline review threads;
`ALL_REVIEW_FEEDBACK` additionally permits top-level commented review summaries.
Ordinary PR conversation comments never trigger Ratchet or advance its review
snapshot. PR states: `IDLE` / `CI_RUNNING` / `CI_FAILED` / `REVIEW_PENDING` /
`READY` / `MERGED`. A workspace-level toggle controls whether auto-fix is
active. Admin settings control the default ratchet state for new workspaces and
the global review-trigger mode.

### State

The ratchet's mutable state lives in a 1:1 `WorkspaceRatchet` row (`enabled`,
`lastCheckedAt`, `activeSessionId`, `dispatchSnapshotKey`, `dispatchOutcome`,
`dispatchRetryCount`), written only by `workspace-ratchet.accessor.ts`; reads
flatten it back onto the workspace under the old `ratchet*` names.

`ratchetState` is **not** stored: it is projected by `deriveRatchetState`
(`src/shared/core/ratchet-state.ts`) from `ratchetEnabled` plus
`WorkspacePR.state`/`ciStatus`/`reviewState`/`hasMergeConflict`, computed at the
same accessor boundary that flattens the side tables. The 127-line transition
table it used to be validated against permitted all 49 of its 49 state pairs and
is gone, as are the compare-and-swap on `state` and the two settling writes
(disable, `markPrClosed`) that forced it to `IDLE` — a disabled workspace and a
closed PR both derive to `IDLE`. `WorkspacePR.hasMergeConflict` was added to
hold the one input that was previously observed on every fetch but only ever
stored as the derived `MERGE_CONFLICT` value.

Because the projection reads the cache, a ratchet check persists its whole
observation (`prState`, `prReviewState`, `prCiStatus`, `hasMergeConflict`) via
`recordPrObservation` rather than CI alone — otherwise a merge or a new
changes-requested review would not be visible until the separate PR-sync poller
caught up.

### Dispatch tracking

Each fixer dispatch is tracked via an explicit record on that row (snapshot key
+ outcome `RUNNING`/`COMPLETED`/`DIED` + retry count): deliberate stops and
clean exits settle as `COMPLETED` (no re-dispatch while the PR state is
unchanged), unexpected exits settle as `DIED` and are re-dispatched for the same
PR state up to 3 times.

A `dispatchStalled` boolean on the same row records the ratchet's own conclusion
that it will not act again until the PR changes — set both when a settled
dispatch achieved nothing for an unchanged snapshot key and when a `DIED` fixer
exhausts its retries, cleared by `resetSettledDispatch`, `disable`, and the next
dispatch. The set is a compare-and-swap pinned to the `dispatchSnapshotKey` the
check evaluated, so a concurrent PR observation or disable wins rather than
being overwritten by a check that has already been superseded; it returns
whether it flipped the flag, and only that transition emits
`RATCHET_DISPATCH_CHANGED`.

That event is load-bearing: a stall is by definition nothing changing, so
neither the PR-observation write nor the ratchet-state transition fires, and
without it the WORKING-to-WAITING move would wait for the next reconciliation
sweep. It is what moves a stuck workspace out of the WORKING column; the
snapshot key hashes `statusCheckRollup` detail `WorkspacePR` does not store, so
no reader can re-derive it.

Review comments belonging to resolved review threads (GraphQL
`reviewThreads.isResolved`) are excluded from fixer dispatch prompts and from
the "has actionable review comments" trigger; they still count toward the
review-activity timestamp so dispatch snapshot keys stay stable when threads get
resolved. Dispatch state is persisted as soon as prompt execution begins,
without waiting for the full ACP turn to complete; a later prompt failure
conditionally settles the matching dispatch as `DIED`.

## PR cache

Everything cached from GitHub about a workspace's PR lives in a 1:1
`WorkspacePR` row (`url`, `number`, `state`, `reviewState`, `ciStatus`,
`hasMergeConflict`, `syncedAt`, `discovery*` scheduling, `ciFailedAt`,
`ciLastNotifiedAt`, `reviewLast*` cursors), written only by
`workspace-pr.accessor.ts`; reads flatten it back onto the workspace under the
old `pr*` names, so the snapshot wire, the v4 export format and the client are
unchanged.

A row exists for every workspace, including those with no PR, because discovery
claims its backoff before a PR exists. `syncedAt` was `prUpdatedAt` on
`Workspace`, a name that read as GitHub's PR `updated_at` but always held the
caller's observation time. Claiming a discovery attempt no longer bumps
`Workspace.updatedAt`, so polling no longer registers as workspace activity.

## PR fetch coordination

The scheduler's PR sync and the ratchet both fetch the same workspaces' PRs, so
both go through `prFetchCoordinator`
(`src/backend/services/github/service/pr-fetch-coordinator.ts`), which runs the
fetch inside a workspace-scoped claim and declines to run it at all when another
caller fetched that workspace within the cooldown or is fetching it right now.

It replaced a registry with a three-call claim protocol (`startFetch`, then
`register` or `cancelFetch`) plus a token the caller threaded through its own
try/catch — duplicated at both call sites and exposed as five methods on
`RatchetGitHubBridge`, now one. Scoping the claim to a callback makes releasing
it a `finally` rather than a caller obligation; the token survives as an
internal detail only because claims still expire, so a late release must not
delete a newer one.

Two options carry what the callers need: `ignoreCooldown` (event-driven ratchet
checks recompute now, but still defer to a fetch actually in flight) and
`countsAsFetched` (PR sync reports failure as a value, and a failed refresh must
not start a cooldown).

It is deliberately **not** a rate limiter — the shared GitHub budget lives one
level down in `GitHubCLIService`: a process-wide `pLimit` on `gh` spawns, a
one-minute fast-fail once GitHub pushes back, and singleflight dedup of
identical in-flight reads. That last one cannot dedupe these two callers,
because they fetch the same workspace with different `gh` commands; that is the
gap the coordinator fills. The scheduler's own `pLimit(3)` and the ratchet's
workspace limit stay separate on purpose: merging them would make a large sync
batch starve ratchet checks.
