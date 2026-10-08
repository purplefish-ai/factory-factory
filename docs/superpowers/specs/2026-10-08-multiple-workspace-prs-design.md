# Multiple Pull Requests per Workspace

## Intent and agreed behavior

A workspace can retain multiple associated pull requests. Adding a PR must not
replace another. The user explicitly chose to have Ratchet watch every open PR
and requested a minimal, polished interface.

Each PR has independent GitHub observations and Ratchet dispatch history. The
workspace retains one Ratchet toggle and allows at most one active fixer at a
time because all sessions share its worktree. Viewing a PR never changes which
PRs Ratchet watches.

Existing associations, automation history, and backups must survive the change.
Workspace completion, archive prompts, and CI summaries consider the whole
collection. One merged PR cannot hide another open or unsynchronized PR.

## Approach

Use a real one-to-many association with PR-scoped cache and dispatch records.
Keep discovery scheduling and the automation toggle scoped to the workspace.
This follows the existing accessor ownership boundaries and avoids an implicit
primary PR that silently excludes other PRs from automation.

A history list with one active PR would be smaller but contradicts the user's
automation choice. Storing a JSON array would make conditional observation
writes, uniqueness, migration, and dispatch coordination harder to enforce.

## Interface

Use one compact PR menu in the workspace header. With one PR, its trigger shows
the PR number and a subtle status indicator. With several, it shows the PR icon,
"PRs", the count, and a chevron. With none, expose "Add PR" through the existing
association entry point. Keep the existing Create PR action when the current
branch has changes and no open PR associated with that branch.

The menu presents open PRs first, followed by merged and closed history. Each
row shows the number, a truncated title with a full-title tooltip, and a small
status label. Branch metadata is secondary. Pending synchronization shows
"Syncing"; missing titles fall back to the repository and number parsed from the
URL. Rows open the specific PR on GitHub. A restrained row action menu contains
"Run review" for open PRs and "Remove from workspace". Removing an association
never closes or deletes the GitHub PR. Use the existing dialog primitives for
removal confirmation.

"Add PR" appears once at the bottom of the menu and opens a single URL input
dialog. A duplicate attachment succeeds without adding a row or resetting its
dispatch history. If the first GitHub fetch fails, retain the association, show
its unsynchronized state, and allow background refresh to recover it.

The menu also provides the explicit target for PR-specific actions; no
persistent primary selection, new workspace tab, or large PR dashboard is
needed. The existing review detail screen continues to operate on its explicit
PR identity. Workspace-level review buttons open the PR choice when multiple
eligible PRs exist and retain the direct action when exactly one exists.

Sidebar and board rows keep one aggregate status indicator and a compact PR
count when there are several. Their PR action opens the same small menu rather
than arbitrarily opening one PR. Mobile exposes the same actions, with bounded
menu width, truncation, scrolling, and touch-friendly rows. Use existing theme
tokens, Phosphor icons, focus treatment, and keyboard navigation. Status must
remain understandable without color. Keep the header's width stable as the
number of PRs grows.

## Persistence and migration

- Change `Workspace.pr` to `Workspace.prs: WorkspacePR[]`.
- Give `WorkspacePR` its own stable ID, an indexed workspace foreign key, and a
  unique `(workspaceId, url)` constraint. Its URL is non-null. Store title, head
  branch, and base branch alongside the existing cached status and notification
  cursors. Unknown GitHub data remains nullable or uses the existing neutral
  defaults. A nullable `detachedAt` marks associations the user removed;
  retained tombstones prevent discovery from immediately adding them again.
- Move discovery fields to a one-to-one `WorkspacePRDiscovery` row. A workspace
  with no PR needs discovery scheduling, not an empty PR record.
- Keep `WorkspaceRatchet` for the enabled toggle, workspace check time, and
  active fixer ownership. Include the target PR ID in that ownership.
- Add a one-to-one `WorkspacePRRatchet` row for each PR's check time, dispatch
  snapshot key, outcome, retry count, and stalled flag. PR deletion cascades its
  dispatch record; detachment clears only matching workspace fixer ownership.
  Deleting a workspace cascades all its records.
- Declare new models and sole writers in the service registry. Keep Prisma
  writes in workspace resources and cross-service coordination in orchestration.

The SQLite migration copies every known URL into a PR row, moves discovery
scheduling for every workspace, and transfers the old dispatch history to the
previously associated PR. Existing active-session ownership is preserved when
its PR exists. Empty old PR rows become discovery rows only. Add foreign-key
indexes and preserve cascades. Do not infer a PR number from a stale cache when
the attached URL identifies a different PR.

## Service contracts and observation safety

Workspace reads and snapshots expose `prs` with stable PR IDs and PR-scoped
facts. Shared schemas define the wire representation. Workspace summaries are
explicitly derived from the collection; they are not the state of a selected PR.
Replace runtime singleton callers across tRPC, bridges, streaming snapshots,
client adapters, archive behavior, and child-workspace displays.

Attach adds an association; detach marks a specified association as removed and
excludes it from all UI and automation reads. Explicit reattachment clears the
tombstone and resets settled dispatch bookkeeping without adopting an older
session. Discovery never clears tombstones. PR-specific refresh, review, and
dispatch calls take both workspace ID and PR ID. Validate that the association
belongs to that workspace before operating. GitHub fetches use the PR URL's
repository and number, not the workspace's other attachments.

Conditional observation writes guard PR identity, active association status, and
the observed cache version. A response for one PR can update only that row,
never another attachment. A response received after removal cannot recreate the
association. An attachment or refresh must not overwrite the workspace branch
from a PR's head branch. Branch metadata belongs to the PR; workspace branch
changes remain worktree operations.

Snapshot invalidations reread and publish the whole collection and aggregate
state together. Preserve the existing worker's cancellation, retry, and archive
suppression guarantees. A late projection must not restore a removed PR or a
superseded collection.

## Discovery and synchronization

Keep batched repository discovery, activity resets, backoff, candidate limits,
and exact branch matching. Workspaces remain eligible when they already have
PRs. Associate all newly discovered matching URLs idempotently. Preserve the
creation-time guard and choose the newest eligible workspace for a reused
branch, while allowing multiple matching PRs for that workspace.

Validate a discovery claim once for an atomic batch of attachments; the first
attachment must not invalidate subsequent PRs from the same claimed lookup.
Existing attached URLs do not count as newly discovered. Continue honoring
branch-renaming and activity races. Explicitly attached PRs may have other head
branches; discovery still uses the workspace's tracked branch.

Sync stale PR rows independently. Fetch cooldowns and in-flight claims use the
association identity so fetching PR A does not suppress PR B. Preserve GitHub's
shared rate budget and existing batch limits. A failed refresh leaves that PR
eligible for retry without blocking its siblings. Stop and archive checks apply
throughout each batch. Terminal PRs are excluded from active Ratchet monitoring.
Unsynchronized attachments remain eligible for recovery.

## Ratchet scheduling and lifecycle

Observe every eligible PR in a workspace, even while another PR's fixer is
active. Persist each observation and assess dispatch eligibility using that PR's
history, retaining current review filtering, dispatch deduplication, stalled
behavior, and bounded crash retries.

Serialize dispatch decisions per workspace and claim active fixer ownership
atomically with the PR-specific dispatch record. Order actionable candidates by
oldest PR check time, then stable PR ID. Check all candidates and skip stalled
or exhausted ones so one PR cannot starve the others. An active fixer blocks
another dispatch, not observation of other PRs. Existing active workspace
sessions retain the current protection against conflicting automatic work.

Bind every new fixer to its target PR in persisted session metadata. Prompts
include that PR's exact URL, repository, number, and head branch. Preserve the
existing behavior for moving to a target branch through the agent; no automatic
checkout occurs when the user merely attaches or views a PR.

Session completion and crash callbacks settle only the matching PR dispatch and
workspace ownership. Merging, closing, or removing PR A stops only A's fixer,
leaving sessions for PR B intact. A stale callback cannot clear a later
dispatch. Disabling Ratchet prevents new dispatches for all PRs and preserves
the current disable/session behavior; enabling resumes collection-wide
monitoring.

## Aggregate workspace state

Open states include draft, open, approved, and changes requested. An attached PR
whose state is not fetched yet remains nonterminal. Terminal history does not
override any nonterminal attachment.

For nonterminal PRs, aggregate CI is failure if any fails, otherwise pending if
any is pending or unknown, otherwise success. Aggregate conflict is true if any
nonterminal PR conflicts. Ratchet status keeps the current priority: CI failure,
merge conflict, CI running, review pending, then ready. A disabled workspace
derives idle automation while its PR and CI summaries remain visible.

A workspace with no associations retains current no-PR behavior. A collection
with only terminal PRs is merged if at least one merged, otherwise closed.
Archive confirmation remains required for any nonterminal attachment. Existing
session and lifecycle rules still take precedence over PR summaries for working
and archived workspace states.

Periodic-task completion recognizes any newly associated PR. Its existing
historical execution link remains a specific PR reference; the workspace UI
shows the full collection. Auto-iteration and issue archive notifications use
the aggregate terminal decision and link the relevant merged PRs.

## Backups and compatibility

Export a new version containing the full PR collection and its dispatch records.
Continue accepting version 4: convert its singleton PR to zero or one
association, preserve discovery fields and dispatch history, and preserve
workspaces with no PR. New-version round trips retain every association and
notification cursor. Do not silently export multiple PRs through the old
singleton format. Restore runtime session pointers according to the existing
backup policy rather than inventing live sessions.

## Validation and acceptance

Add focused regressions for two independent attachments, duplicate attachment,
failed initial fetch recovery, refresh races, removal during fetch, unchanged
workspace branch, multiple PR discovery, and PR-specific cooldowns. Verify the
migration for no-PR, open, merged, closed, and active-fixer workspaces.

Ratchet tests must show both PRs being observed, independent deduplication and
retry budgets, one concurrent fixer, progress after its session ends, recovery
after restart, and no unrelated session shutdown when another PR merges.

Cover aggregate failure/pending/conflict/review/terminal combinations, archive
confirmation, snapshot races, and version 4 import plus new-version round trips.
UI tests and stories cover zero, one, several, mixed-terminal, unsynchronized,
and many long-titled PRs; keyboard actions, mobile layout, pending mutations,
removal failure, and explicit review targeting.

Run `pnpm check:fix`, `pnpm typecheck`, affected Vitest tests, `pnpm check`, and
`pnpm check:prisma-schema`. Inspect the final diff and visually verify the menu
at desktop and mobile widths. Update the architecture guides to describe the
collection and ownership rules. Report any unavailable checks.
