# Pull Request Automation

## PR detail diffs

The PR detail panel uses `parseFileDiff` in `src/lib/diff/parse.ts` to display
repository-relative destination filenames. It distinguishes Git's `a/` and `b/`
prefixes from characters inside paths, decodes Git's quoted paths, and uses
destination and rename metadata to disambiguate filenames containing spaces.
Metadata only updates filenames before a hunk; header-like additions and
deletions inside hunks remain diff content.

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

One narrow, deliberate exception to "ordinary comments never trigger Ratchet": a
review or fallback conversation summary whose body carries the Adversarial
Review feature's marker (`src/shared/adversarial-review.ts`) is always
actionable, regardless of `ratchetReviewTriggerMode`, provided its author
matches the authenticated GitHub identity — see
[Adversarial Review](../design/adversarial-review.md). This exists because this
app's own `gh` identity is also the PR's author, which rules out using GitHub's
native `REQUEST_CHANGES` review state to signal "actionable" the way a human
reviewer's does.

The dispatch prompt asks the agent to refresh GitHub state, address actionable
feedback, fix CI, and resolve conflicts autonomously. It leaves execution order
and repository-specific checks to the agent. Base-branch updates happen when
needed; conflict-only fixes may be pushed, and the PR stays open. Declined
feedback and blockers are reported rather than forcing unnecessary edits.

The PR reply setting controls comments and thread resolution. When enabled,
agents reply to unaddressed feedback and request re-review after fixes without
duplicate messages. When disabled, they leave comments and threads untouched and
request re-review through reviewer assignment only. Supplied review data remains
escaped and explicitly untrusted. A missing or empty dispatch template fails
dispatch instead of falling back to a second set of instructions.

### State

A workspace retains all associated PRs in `Workspace.prs`. Each PR has a stable
ID, URL, GitHub cache, and independent `WorkspacePRRatchet` history.
`WorkspaceRatchet` owns the workspace toggle, check time, and one active fixer
slot (`activePrId`, `activeSessionId`). Only the matching session can settle
that slot. All open PRs are observed; checks visit the least recently checked
PRs first and continue observing siblings while a fixer is busy. Session
acquisition and review actions carry the specific PR ID.

`deriveWorkspacePRSummary` derives workspace CI, conflict, completion, and stall
state from the complete active collection. Any open or unsynchronized PR keeps
the workspace nonterminal. Failure takes precedence over pending checks, and a
workspace stalls only when all actionable PRs have exhausted their dispatches
and none is waiting or running. Per-PR state still uses `deriveRatchetState`.

Snapshot invalidations re-read and publish the collection and summary together
through `RatchetProjectionWorker`. Its generation guard discards superseded
reads, with three attempts at 1s and 2s delays and archive/stop suppression.
Attachments immediately publish a neutral PR alongside existing siblings, so a
late merged observation cannot bypass archive confirmation. Reconciliation is
the safety net after retry exhaustion.

### Dispatch tracking

Each fixer dispatch is tracked on its PR’s `WorkspacePRRatchet` row (snapshot
key

- outcome `RUNNING`/`COMPLETED`/`DIED` + retry count): deliberate stops and
  clean exits settle as `COMPLETED` (no re-dispatch while the PR state is
  unchanged), unexpected exits settle as `DIED` and are re-dispatched for the
  same PR state up to 3 times.

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

Review summaries superseded by the same author's approval are excluded from
prompts and review activity. Different valid submission times take precedence;
same-second or missing times use an explicit ordinal from GitHub's
[chronologically ordered REST reviews endpoint](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request),
including across pages. Ratchet never infers order from its input array or
opaque review IDs; without enough ordering evidence, it retains the feedback.
Deleted reviewers retain their feedback under an explicit unknown identity;
their approvals never supersede another unknown author’s feedback.

Inline review comment fetches retain at most 2,000 comments, ordered by newest
update first at the API boundary. Hitting that budget drops older activity
rather than the newest comment or edit used in the dispatch snapshot. Returned
comments are in ascending update order. Comments from deleted GitHub accounts
are retained with an empty author login, preserving their feedback and activity
timestamps without inventing an identity or failing the PR fetch.

Review comments belonging to resolved review threads (GraphQL
`reviewThreads.isResolved`) are excluded from fixer dispatch prompts and from
the "has actionable review comments" trigger; they still count toward the
review-activity timestamp so dispatch snapshot keys stay stable when threads get
resolved. Dispatch state is persisted as soon as prompt execution begins,
without waiting for the full ACP turn to complete; a later prompt failure
conditionally settles the matching dispatch as `DIED`.

## PR cache

Each `WorkspacePR` stores URL, number, title, head/base branches, state, review
state, CI, merge conflict, sync time, and notification/review cursors. The
`workspace-pr.accessor.ts` sole writer guards observations by workspace ID, PR
ID, active association, and revision. Fetches pin that revision before GitHub
I/O; stale responses cannot modify siblings or resurrect removed associations.
PR head metadata never renames the workspace’s worktree branch.

Adding a URL is idempotent and retains siblings and their dispatch history.
Removing a PR sets a tombstone, advances its revision, and releases only its
fixer slot; it does not close the GitHub PR. Discovery honors tombstones, while
explicit reattachment clears one and resets its dispatch history and cached
status before fetching. Failed initial synchronization retains a visible
unsynchronized association. The compact PR menu contains explicit GitHub,
review, remove, and add actions.

`WorkspacePRDiscovery` owns workspace discovery scheduling and backoff,
including workspaces that already have PRs. Repository batches attach all
matching URLs under one validated claim, choosing the newest eligible workspace
when a branch is reused. Activity and branch changes invalidate claims. Every
attached PR is eligible for status sync, including terminal PRs that may reopen.

Backups export version 5 with the collection, tombstones, cursors, independent
histories, discovery, and fixer ownership. Version 4 imports normalize into this
shape, creating no association when the old URL was empty. Validation rejects
duplicate PR identities and ownership outside the workspace before restoration.

Idle-triggered PR refreshes retain a 30-second cooldown per workspace. At the
workspace cache limit, only expired cooldowns are removed; if all entries are
still live, new idle refreshes are skipped until a later idle event can claim a
slot. The regular PR sync poll remains the fallback under capacity pressure.

## PR fetch coordination

The scheduler's PR sync and the ratchet both fetch the same workspaces' PRs, so
both go through `prFetchCoordinator`
(`src/backend/services/github/service/pr-fetch-coordinator.ts`), which runs the
fetch inside a PR-scoped claim and declines to run it at all when another caller
fetched that PR within the cooldown or is fetching it right now.

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
