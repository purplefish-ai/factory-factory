# Design Doc: Adversarial Review Across Child Workspaces

> **Status:** Proposed. Step 1 (checkout context) is implemented; the rest is
> not yet. It builds on the shipped [Adversarial Review](adversarial-review.md)
> feature and the
> [child workspace](../architecture/agent-runtime.md#child-workspaces) runtime.

## Summary

Let a parent workspace start an adversarial review of **every open PR on each of
its child workspaces** with one action, from either side:

- **Agent:** the parent agent gets a new MCP tool,
  `run_child_adversarial_reviews`. A user can then type "run adversarial review
  on all my children" in the parent chat.
- **User:** the parent's **Child workspaces** panel gets a **Review children**
  button.

Each review is the same review the per-PR review action starts today. It uses
the reviewer provider and model set in Admin, runs in plan mode inside the child
workspace, and posts to that PR (when `postReviewToGitHub` is on). If Ratchet is
on for that child, Ratchet picks up the findings.

This feature adds the following on top:

- a batch entry point that covers every child and every open PR on each one
- a queue that limits how many reviews run at once, starting each reviewer only
  when a slot opens
- correct code context for PRs that are not checked out in the child's worktree
  (see
  [Reviewing PRs that are not checked out](#5-reviewing-prs-that-are-not-checked-out))
- one completion message per PR sent to the parent's inbox
- live child status in the parent's **Subagents** pane: what each child's own
  agent is doing, kept separate from the review status of each of its PRs (see
  [Child status in the Subagents pane](#child-status-in-the-subagents-pane))

## Can you do this today?

Not reliably. Here is what exists now:

- `adversarialReview.trigger` (`src/backend/trpc/adversarial-review.trpc.ts`)
  takes one workspace and an optional `prId`. Two places call it: the toolbar
  button, which reviews the workspace's selected PR, and the PR chip menu, which
  has a review action per attached PR (`use-workspace-pr-actions.ts:55`).
  Reviewing every PR on every child means opening each child and clicking once
  per PR.
- The parent agent's MCP server (`src/backend/mcp/workspace-mcp-server.ts`)
  gives parents `list_projects`, `spawn_child_workspace`,
  `send_message_to_child` and `archive_child_workspace`. It has no review tool.
  It also has no tool for listing children, so a parent agent only knows child
  IDs from earlier spawn results in its own conversation.
- As a workaround, the parent could `send_message_to_child` asking each child
  agent to "review your PR". That runs a review on the child's **own** provider
  and model, which is the same-model self-review that Adversarial Review exists
  to avoid.
- Reviews are fire-and-forget (`void runAdversarialReviewTurn(...)`,
  `adversarial-review.orchestrator.ts:145`). Their result only reaches the PR
  and the logs. Nothing tells the parent when a review finished, what it found,
  or that it failed.
- **Existing bug: the review prompt assumes the PR is checked out.**
  `prompts/adversarial-review/dispatch.md` tells the reviewer that "the
  repository checked out in this session is that same PR at its current head".
  But a workspace can have several attached PRs, through attachment, discovery,
  or an agent running `gh pr create` on another branch or in another repo, and
  its worktree has only one branch checked out. When you review any other PR
  from the chip menu today, the reviewer reads surrounding code from the wrong
  branch, or from an unrelated repo, and still treats it as authoritative.
  Reviewing every PR would hit this on nearly every child that has more than one
  PR, so this design fixes it.
- **The parent can barely see what its children are doing.** For parent
  workspaces, the Subagents pane (`agents-panel.tsx`) embeds
  `ChildWorkspacesPanel`, but each row shows only the workspace lifecycle
  (`READY`/`PROVISIONING`/…) and the board column. `workspace.listChildren`
  already builds each child's session summaries and full derived state,
  including `statusReason` (for example "Needs permission" or "Fixing review
  comments"), and then returns only `kanbanColumn`. A running review session
  also counts toward `hasWorkingSessionSummary`, so a child under review looks
  exactly like a child whose agent is working.

## Goals / Non-goals

**Goals**

- One action, from the parent's agent or the parent's UI, reviews **every open
  PR on every eligible child**, or a chosen subset of children.
- Each PR is reviewed against **its own code**, not whatever branch the child
  worktree has checked out.
- Reuse the existing per-PR path for everything else: idempotency, plan-mode
  startup, the session limit, posting and the Ratchet marker.
- Report each PR's result right away (queued / already running / skipped with a
  reason / failed). PRs that are ineligible or fail do not abort the batch.
- Send one completion message per PR to the parent's inbox.
- Handle many children and PRs: a configurable global limit on reviews running
  at once, no idle reviewer processes while queued, and at most one review
  session per child at a time so a child with several PRs doesn't fill up its
  session limit.
- Let the parent, both user and agent, see each child's live status in the
  Subagents pane, with the child's own agent activity kept separate from review
  activity on each of its PRs.

**Non-goals**

- Per-batch reviewer provider/model overrides. The Admin-wide setting stays the
  only source.
- Reviewing a child's worktree changes that have no PR yet.
- Recursion. Workspace depth is capped at 1, so a child never has children of
  its own.
- Surviving restarts. Single reviews today are in-memory fire-and-forget, and
  the queue is in memory too. A backend restart drops queued and running
  reviews.
- Automatic re-review when a child pushes new commits.
- Changing workspace-wide status for review sessions. The board card, sidebar
  and `workspace.get` still count a running review as "Agent working". Only the
  Subagents pane's child rows leave review sessions out (section 7). Changing
  the shared derivation would also change board behavior, for example moving a
  child from Working to Waiting during a review.
- Showing children's own provider sub-agents nested under their rows in the
  parent's Subagents pane. That needs session tracking per child, which the
  panel doesn't have. The row links into the child, where they are visible.

---

## UX

### Parent agent (MCP)

New parent-only tool in `workspace-mcp-server.ts`:

```ts
const RUN_CHILD_REVIEWS_TOOL = {
  name: 'run_child_adversarial_reviews',
  description:
    'Queue an adversarial review (a read-only review by the Admin-configured reviewer ' +
    'model, posted to the PR) of every open pull request on child workspaces. ' +
    'Omit childWorkspaceIds to cover every child. Only call when the user asks for it. ' +
    'Results arrive later as one COMPLETION mail per PR.',
  inputSchema: {
    type: 'object',
    properties: {
      childWorkspaceIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of child workspace IDs. Defaults to all children.',
      },
    },
    required: [],
  },
};
```

- It is listed and dispatched only when `!hasParent`, and it is gated by the
  `childWorkspacesEnabled` check, the same way the other workspace tools are.
  Add the name to `workspaceToolNames` (`workspace-mcp-server.ts:408`) and to
  the parent tool array in `tools/list` (`:478`).
- The tool returns one line per PR, grouped by child, for example:

  ```text
  Queued 5 PR reviews across 3 children (3 running now), 1 already running, 2 skipped:
  api-refactor (id: …)
    - #412 queued
    - #418 queued
    - #420 already running
  ui-polish (id: …)
    - #415 queued
    - #409 skipped — merged
  docs-only (id: …)
    - skipped — no pull requests
  cross-repo (id: …)
    - org/other#77 queued (diff-only: PR is in another repository)
    - #431 queued
  ```

- The tool should be called only when the user asks, for two reasons. Reviews
  post to GitHub under the user's `gh` identity, and with Ratchet on they can
  trigger fixer sessions. The tool description says this. Provider permission
  prompts apply as they do for any MCP tool, so the active preset decides
  whether the call needs approval. This matches `spawn_child_workspace`.

A second parent-only tool, `list_child_workspaces`, wraps
`workspace.listChildren`. For each child it returns the id, name, project, agent
status line, each attached PR (number, state, URL) and its review lines, the
same information the Subagents pane shows (see
[Child status in the Subagents pane](#child-status-in-the-subagents-pane)). The
agent can use it to pick a subset of children or to report progress.

### Parent UI (Child workspaces panel)

In `src/client/features/workspace/child-workspaces-panel.tsx`:

- Add a `ShieldWarningIcon` button in the panel header next to **New child
  workspace**, titled **Review children**. It is shown only when at least one
  child has an open PR. The panel already loads `listChildren`, which includes
  each child's `prs`.
- Clicking it opens a `ConfirmDialog` (never a native `confirm`), for example:
  "Review 7 open PRs across 4 child workspaces? Reviews use Codex · gpt-5.1, run
  3 at a time, and are posted to each PR." When `postReviewToGitHub` is off, the
  last clause becomes "and stay in-app".
- On success, show a toast with the counts from the response, for example
  "Queued 5 · already running 1 · skipped 2". Invalidate `listChildren` and each
  affected child's `session.listSessions`.
- Per-row agent and review status: see the next section.

The per-workspace toolbar button and PR chip review actions keep their UI, but
they now use the same queue and checkout handling (below), so they also pick up
the fix for PRs that are not checked out.

### Child status in the Subagents pane

The parent's **Subagents** pane already lists provider sub-agents for the
current session first, then (for parents with child workspaces enabled) the
embedded `ChildWorkspacesPanel`. The pane stays in that order and keeps that
component. Its child rows change from "lifecycle dot + board column" to a status
view with two clearly separate parts: **what the child's own agent is doing**
and **what is happening with reviews of its PRs**.

```text
Child workspaces  4 · 2 working · 1 needs you · reviews: 1 running, 3 queued   [🛡] [+]
────────────────────────────────────────────────────────────────────────────────────
● api-refactor                                    #412 #418 #420             ↗
  Agent working · factory-factory
  🛡 Reviewing #412 · Codex · 2m                                   (spinner)  ↗
  🛡 #418 queued (2nd)
  🛡 #420 reviewed 14m ago · 1 blocking · 2 suggestions                       ↗
● ui-polish                                       #415                       ↗
  Needs permission · web-app                                    (attention tone)
  🛡 #415 queued (1st)
● cross-repo                                      org/other#77 #431          ↗
  Fixing review comments · factory-factory
  🛡 org/other#77 review failed: Could not fetch diff                         ↗
● docs-only                                                                  ↗
  Ready for next prompt · docs
```

**Agent line.** This uses the existing `statusReason` (`label`, `tone`,
`needsUser`) rendered with the same tones as `KanbanStatusChip`, so the wording
matches the child's board card and sidebar: "Agent working", "Needs permission",
"Needs plan approval", "Waiting for CI", "Fixing review comments", "Setting up",
"Setup failed", "Ready for next prompt", and so on. The row's status dot takes
the reason's tone instead of the lifecycle-only `statusTone()`. The project name
follows the label.

For this line, `statusReason` is computed **without adversarial-review
sessions** (see backend section 7), so "Agent working" means the child's own
agent or a Ratchet fixer is working, never the reviewer. Review sessions cannot
raise permission or question prompts (the review permission bridge denies them
automatically), so excluding them hides no prompt that needs the user.

**Review lines.** There is one line per PR that has review activity, in PR ID
order, and nothing for PRs with none:

| State                   | Line                                                      | Click                                                         |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| queued                  | `#418 queued (2nd)`. Position in the global queue.        | none                                                          |
| running                 | `Reviewing #412 · Codex · 2m`, with a spinner             | opens the child at its review session (`?session=<id>`)       |
| posted / in-app only    | `#420 reviewed 14m ago · 1 blocking · 2 suggestions`      | opens the review transcript. A secondary link goes to the PR. |
| no findings block       | `#420 review finished without parseable findings`         | opens the transcript                                          |
| skipped (session limit) | `#415 review skipped: child at session limit` (attention) | opens the child                                               |
| failed                  | `#77 review failed: <message>` (danger)                   | opens the transcript, if a session was created                |

`fetched_head` and `diff_only` reviews add a muted "· other branch" or "· diff
only" note, so the parent knows how much context the review had. Finished,
skipped and failed lines stay visible for 24 hours, or until a newer review of
that PR starts.

**Header.** The panel header summarizes counts across all children: "4 · 2
working · 1 needs you · reviews: 1 running, 3 queued". Children that need the
user keep their position, since rows stay in creation order to avoid jumping,
but use the attention tone.

**Clicks.** Clicking the row still navigates to the child workspace. Review
lines are separate links that add `?session=<sessionId>`, which
`workspace-detail-container.tsx:72` already supports for selecting a session on
load. Review transcripts stay viewable after the turn ends because `stopSession`
stops the process but keeps the session and its history.

**Freshness.** `listChildren` already polls every 15 seconds. It polls every 3
seconds while any child is working, needs the user, or has a queued or running
review, and drops back to 15 seconds when everything is idle. A successful
**Review children** call also invalidates it immediately. No new subscription is
needed. Children can live in other projects, so the project-scoped workspace
snapshot stream does not cover them.

**Parent agent.** `list_child_workspaces`, previously optional, is now part of
this design. It returns the same agent line and review lines as plain text, so a
parent agent asked "how are my children doing?" sees what the user sees.

---

## Backend design

### 1. Split the single trigger into "try" and "throw" forms

Today `triggerAdversarialReviewLocked` reports every precondition failure by
throwing `ApplicationError('PRECONDITION_FAILED', <message>)`. A batch needs to
tell "skipped" apart from "failed" without matching on message strings, so add
an internal discriminated result:

```ts
type SkipReason =
  | 'workspace_not_found'
  | 'no_worktree'
  | 'no_pull_requests'
  | 'pr_not_open'        // MERGED / CLOSED
  | 'pr_not_synced'      // NONE: attached but not yet observed
  | 'session_limit';

type AdversarialReviewAttempt =
  | { status: 'queued' | 'already_active'; position?: number }
  | { status: 'skipped'; reason: SkipReason };
```

- `tryEnqueueAdversarialReview(workspaceId, prId, options?)` runs today's
  precondition checks and the per-PR `inFlightTriggers` lock, then adds the
  review to the queue (section 3). It returns `skipped` for expected
  preconditions and throws only on unexpected errors, such as an unparseable PR
  URL.
- `triggerAdversarialReview` keeps its tRPC contract. It calls the try form and
  maps `skipped` back to today's `ApplicationError` messages. One change: when
  the review has to wait in the queue it returns `{ status: 'queued' }` without
  a `sessionId`. The toolbar button and chip menu toast "Adversarial review
  queued" for that case.

### 2. Batch orchestrator

Add `triggerChildAdversarialReviews` to
`src/backend/orchestration/adversarial-review.orchestrator.ts`. It belongs
there, not in `workspace-children.orchestrator.ts`, because it is review logic
that only reads child relationships:

```ts
export interface ChildPrReviewResult {
  childWorkspaceId: string;
  childName: string;
  prId: string | null;          // null for child-level skips (no worktree, no PRs)
  prUrl: string | null;
  prNumber: number | null;
  context: 'checked_out' | 'fetched_head' | 'diff_only' | null; // see section 5
  outcome:
    | { status: 'queued' | 'already_active' }
    | { status: 'skipped'; reason: SkipReason }
    | { status: 'failed'; message: string };
}

export async function triggerChildAdversarialReviews(input: {
  parentWorkspaceId: string;
  childWorkspaceIds?: string[];
}): Promise<{ results: ChildPrReviewResult[] }>;
```

Flow:

1. Check that `userSettings.childWorkspacesEnabled` is on. If it is off, throw
   `PRECONDITION_FAILED`, the same as `createChildWorkspace` does.
2. Load the children with
   `workspaceRelationshipsService.findChildrenWithStatus(parentWorkspaceId)`.
   This returns non-archived children with all attached `prs` (detached rows
   excluded) and sessions.
3. If `childWorkspaceIds` is given, any ID that is not a non-archived child of
   this parent becomes `failed: not a child of this workspace`. This uses the
   same ownership rule as `archiveChild`, which returns FORBIDDEN, so an agent
   cannot target arbitrary workspaces through its parent's tool.
4. For each child, **expand to every attached PR**, in ID order. That is the
   same order `selectWorkspacePR` uses, so the PR the toolbar would pick is
   reviewed first.
   - A child with no worktree gets a single `skipped: no_worktree` row.
   - A child with no PRs gets a single `skipped: no_pull_requests` row.
   - A MERGED/CLOSED PR is `skipped: pr_not_open`. A `NONE` PR is
     `skipped: pr_not_synced`, matching the toolbar, which hides review for
     `NONE`.
   - Each open PR goes to
     `tryEnqueueAdversarialReview(child.id, pr.id, { notifyParent: true })`. Any
     error thrown for one PR becomes a `failed` row for that PR, and the loop
     continues.
5. Return all rows right away. Enqueuing doesn't start a session, so the call is
   fast no matter how many PRs there are.

Expose it through `AppContext.services` (`src/backend/app-context.ts`) next to
`triggerAdversarialReview`, and add a tRPC procedure:

```ts
triggerForChildren: trustedLocalProcedure
  .input(z.object({
    parentWorkspaceId: z.string(),
    childWorkspaceIds: z.array(z.string()).max(50).optional(),
  }))
  .mutation(({ ctx, input }) =>
    ctx.appContext.services.triggerChildAdversarialReviews(input)),
```

`trustedLocalProcedure` is correct here, matching `trigger` and `createChild`.
The MCP server calls the API over localhost, so it passes the trust check.

### 3. Review queue

Ten children with two or three PRs each is a normal setup, so the queue is built
for that case. Today a review creates and starts its session immediately. With
the queue, a review is a lightweight in-memory job until a slot is free:

```ts
interface QueuedReview {
  workspaceId: string;
  prId: string;
  notifyParent: boolean;
  enqueuedAt: number;
}
```

Rules:

- **Global limit.** At most `adversarialReviewConcurrency` reviews are running
  at once across the whole app. This is a new Admin setting (default 3), and
  single-button reviews count toward it too.
- **One running review per child.** A child's PRs are reviewed one after
  another, never in parallel. A child with three PRs therefore uses one session
  slot at a time, not three. This also keeps reviewers from competing over the
  same worktree's git state in section 5. Jobs for other children move ahead
  while a child's earlier PR is running.
- **The reviewer starts at dequeue time.** When a job is dequeued, the
  orchestrator creates the session with
  `createAgentSessionWithinWorkspaceLimit`, starts it in plan mode, and runs the
  turn, exactly as `triggerAdversarialReviewLocked` does now. A queued job holds
  no provider process and no session slot.
- **Session limit is checked at dequeue.** If the child is at
  `MAX_SESSIONS_PER_WORKSPACE` (default 5) when its turn comes, the job is
  dropped as `skipped: session_limit`, and if `notifyParent` is set the parent
  is told by mail. The job is not retried automatically, because a user who has
  filled the child's sessions is actively working there.
- **Idempotency covers the queue.** `already_active` means there is either an
  active `adversarial_review` session for that `(workspaceId, prId)`, which is
  the check that exists today, or a queued job for it. Re-running a batch never
  duplicates work. If a later request sets `notifyParent` on a job that is
  already queued, the flag is merged into the existing job.
- **Queue order.** First in, first out, skipping any job whose child already has
  a review running.
- **Visibility.** A review that is waiting does not appear as a session, so a
  child's session list only ever shows reviews that are actually running. The
  queue's state is exposed for the Subagents pane through
  `getAdversarialReviewStatus` (section 7).

**Admin setting.** Add `adversarialReviewConcurrency Int @default(3)` to
`UserSettings`, edited in `AdversarialReviewSection.tsx` (range 1–10). It needs
a new Prisma migration and an entry in the `userSettings.update` schema, the
same as the other reviewer fields.

The existing `finally` that stops the session after each turn stays. It now also
releases the slot and starts the next eligible job.

### 4. Report completion to the parent

`runAdversarialReviewTurn` currently resolves to `void` and only logs failures.
Change it to resolve to an outcome:

```ts
type AdversarialReviewOutcome =
  | { kind: 'posted'; counts: Record<'blocking' | 'suggestion' | 'nit', number>; summary: string }
  | { kind: 'in_app_only'; counts: …; summary: string }        // postReviewToGitHub off
  | { kind: 'no_findings_block' }                               // nothing parseable
  | { kind: 'skipped'; reason: 'session_limit' }                // dropped at dequeue
  | { kind: 'failed'; message: string };
```

For jobs with `notifyParent`, send **one mail per PR** to the parent with the
existing `deliverWorkspaceNotification` (`direction: 'CHILD_TO_PARENT'`), the
same helper `fireLifecycleNotification` uses:

- `kind: 'COMPLETION'`, `subject: 'Adversarial review finished: #<n>'`. For
  `failed`/`skipped` the subject is `'Adversarial review did not run: #<n>'` and
  the kind is `'BLOCKER'`.
- The body has the PR URL, the review context (checked out / fetched head / diff
  only), the reviewer label, the severity counts and the summary cut to about
  2,000 characters. Full findings live on the PR and in the child's review
  transcript, and the mail says where. Mail is already treated as untrusted data
  and is fetched explicitly through `read_mail`, so it needs no extra fencing.
- `taskKey` is set to `adversarial-review:<prId>`, so repeat batches on the same
  PR group together in the inbox.

**Who gets notified.** Only reviews the parent requested. A user clicking a
review action inside a child should not send mail to the parent. The
`notifyParent` flag lives on the queued job, and for a review that is already
running it lives in a module-level `Set<sessionId>` (the batch adds to it when
the result is `already_active`). Both are cleared in the turn's `finally`.

**Agent wake-up.** Mail delivery already wakes the parent agent with a body-free
signal and fenced retry. Several mails per child are fine because the wake latch
merges mail that arrives while a signal is still pending. No digest is needed.

### 5. Reviewing PRs that are not checked out

At dequeue time the orchestrator decides what code context the reviewer gets and
picks the matching prompt variant. Inputs are the PR's repo (from its URL), the
worktree's `origin` remote, the PR's `headRefName` and head SHA
(`getPRHeadCommitSha`, already fetched), and the worktree's current branch and
HEAD (read with `git rev-parse` in `worktreePath` when the review runs, not from
`Workspace.branchName`). Comparing against `origin` rather than the project's
stored `githubOwner`/`githubRepo` checks the remote that will actually be
fetched from. The project fields are derived from `origin` anyway.

| Context        | When                                                                                                                                              | What the reviewer gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checked_out`  | Same repo, the worktree branch equals the PR's head branch, and the PR head commit is in the worktree HEAD                                        | The checkout is the PR. If the worktree HEAD is ahead of the PR head (unpushed commits), the prompt says so, tells the reviewer to review as of the PR head with `git show`, and notes that local checks include the extra commits. Requiring the PR head commit rules out fork PRs that share the branch name and stale local branches.                                                                                                                                                                   |
| `fetched_head` | Same repo, otherwise                                                                                                                              | Before the turn, the orchestrator runs `git fetch --no-tags --no-write-fetch-head origin +refs/pull/<n>/head:refs/factory-factory/review/<prId>` in the worktree and checks that the PR head commit is now present. `refs/pull/<n>/head` also works for PRs from forks. The prompt says the working tree is **not this PR**, tells the reviewer to read the PR's files with `git show`, `git ls-tree` and `git grep` at the head SHA instead of from disk, and not to run checks against the working tree. |
| `diff_only`    | The worktree's `origin` is not the PR's repository, Git can't inspect the worktree, the fetch fails, or the PR head moved after the diff was read | No usable checkout. The prompt says why, and the review is based on the diff, the PR description, and read-only `gh` commands. The summary must say that context was limited.                                                                                                                                                                                                                                                                                                                              |

Notes:

- **The orchestrator fetches; the reviewer never writes.** The fetch runs from
  the orchestrator, not the agent. It touches only the object store and one
  private ref, never the working tree, the index or any branch, so the child's
  own agent and files are unaffected. `--no-write-fetch-head` avoids colliding
  with the child agent's own fetches. The ref is deleted in the turn's
  `finally`. Because each child runs one review at a time (section 3), two
  reviewers never fetch into the same worktree at once.
- **Fetch failures fall back to `diff_only`.** If the fetch fails (auth,
  network) or the fetched ref no longer contains the head SHA the diff was read
  at (a push landed in between), the review drops to `diff_only` and the
  completion mail says so. It does not fail the review.
- **Both providers can read the PR head.** Claude (plan mode) and Codex
  (read-only sandbox) reviewers can both run read-only `git show` and
  `git diff`, so the prompt only points the reviewer at the head SHA. The prompt
  does not need to include changed-file contents.
- **The existing per-PR path gets the fix too.** The single trigger and the chip
  menu go through the same dequeue code, so they also get this classification.
  That fixes the existing bug described at the top of this doc.
- **Prompt changes.** Split `prompts/adversarial-review/dispatch.md` into a
  shared body plus a `{{CHECKOUT_CONTEXT}}` section rendered per context by
  `buildAdversarialReviewDispatchPrompt`. The ref name, SHAs and branch names go
  through the existing untrusted-data fencing, because branch names are
  user-controlled.
- **Line anchors stay correct.** Posting already anchors comments to the head
  SHA from the fetched diff, which is independent of the worktree.

### 6. Interaction with Ratchet

Nothing changes here. Each review is posted with the marker by the child's
authenticated identity. Ratchet already watches each attached PR separately
(`ratchet.service.ts:274` observes per `prId`), so a finding on any of a child's
PRs reaches that child's Ratchet the same way a manual review does.

### 7. Child status for the parent

`workspace.listChildren` (`src/backend/trpc/workspace/children.trpc.ts`) already
loads each child's sessions, builds `sessionSummaries`, and runs
`assembleWorkspaceDerivedState`. It then returns only `kanbanColumn`. Extend its
output:

```ts
interface ChildWorkspaceListItem {
  // ...existing fields (id, name, status, prs, prSummary, kanbanColumn, project…)
  agent: {
    statusReason: WorkspaceStatusReason; // label, tone, needsUser
    isWorking: boolean;
    pendingRequestType: WorkspacePendingRequestType | null;
  };
  reviews: ChildPrReviewStatus[];
}

interface ChildPrReviewStatus {
  prId: string;
  prNumber: number | null;
  prUrl: string;
  state:
    | 'queued' | 'running'
    | 'posted' | 'in_app_only' | 'no_findings_block' | 'skipped' | 'failed';
  queuePosition?: number;   // 1-based, global, when queued
  sessionId?: string;       // when a session exists (running or finished)
  reviewerLabel?: string;   // e.g. "Codex · gpt-5.1"
  context?: 'checked_out' | 'fetched_head' | 'diff_only';
  startedAt?: string;
  finishedAt?: string;
  counts?: Record<'blocking' | 'suggestion' | 'nit', number>;
  message?: string;         // skip reason or failure message
}
```

**Agent status without review sessions.** Before calling
`hasWorkingSessionSummary`, `computePendingRequestType` and
`assembleWorkspaceDerivedState` for this list, filter out sessions whose
`workflow` is `ADVERSARIAL_REVIEW_WORKFLOW`. Share the predicate through
`src/shared/adversarial-review.ts` (`isAdversarialReviewSession`). Ratchet fixer
sessions stay included, because a fixer working on review comments really is the
child doing work. Workspace-wide derivation (`workspace.get`, board cards,
sidebar) stays unchanged (see Non-goals).

**Review status source.** Add
`getAdversarialReviewStatus(workspaceIds): Map<workspaceId, ChildPrReviewStatus[]>`
to the orchestrator and expose it through `AppContext.services`. It merges:

1. **Queued jobs** from the in-memory queue (section 3), with global position.
2. **Running** reviews: the active `adversarial_review` sessions already loaded
   in `child.agentSessions` (the same RUNNING/IDLE check as
   `findActiveAdversarialReviewSession`), plus the context and reviewer label
   the orchestrator recorded at dequeue.
3. **Recent outcomes**: an in-memory map keyed by `prId`, written in the turn's
   `finally` from the `AdversarialReviewOutcome` (section 4). Entries expire
   after 24 hours and are replaced when a newer review of that PR starts. They
   do not survive a restart. The parent's inbox mail is the durable record.

A PR that appears in several sources reports the newest: queued or running takes
precedence over a recent outcome. Entries for PRs that are no longer attached
are dropped.

`listChildren` stays a `publicProcedure`, matching today. The new fields contain
only status, counts, the reviewer label and error messages, never finding
bodies. Summaries and finding text stay in the review transcript and the
trusted-local inbox.

---

## Edge cases

| Case                                                        | Behavior                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Child has no attached PRs                                   | One `skipped: no_pull_requests` row                                                                              |
| Child has 3 open PRs and 1 merged                           | 3 queued (reviewed one at a time), 1 `skipped: pr_not_open`                                                      |
| PR attached but not yet synced (`NONE`)                     | `skipped: pr_not_synced`                                                                                         |
| Child still provisioning (no worktree)                      | One `skipped: no_worktree` row                                                                                   |
| Child at `MAX_SESSIONS_PER_WORKSPACE` when its job comes up | Job dropped as `skipped: session_limit`. The parent is told by mail.                                             |
| PR already queued or under review                           | `already_active`. `notifyParent` is merged in.                                                                   |
| Two batches race on the same PR                             | The per-PR `inFlightTriggers` lock and the queue's idempotency check prevent a duplicate.                        |
| PR on a branch other than the worktree's                    | `fetched_head` context (section 5)                                                                               |
| PR in another repo than the child's project                 | `diff_only` context. The completion mail and summary say context was limited.                                    |
| PR head force-pushed between enqueue and dequeue            | The diff and head SHA are read at dequeue, so the review covers the current head.                                |
| Child archived while its jobs are queued                    | Jobs for that child are dropped at dequeue (`workspace_not_found`), and the parent gets one mail per dropped PR. |
| Child workspaces turned off in Settings                     | The MCP tool is hidden and rejected, the tRPC procedure throws `PRECONDITION_FAILED`, and the panel is hidden.   |
| Called from a child workspace                               | The tool is not listed and is rejected at dispatch (`hasParent`).                                                |
| Backend restart                                             | The queue and running reviews are lost. No completion mail is sent. Same as single reviews today.                |

---

## Affected / new files

| Area          | File                                                                                                    | Change                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema        | `prisma/schema.prisma` + migration                                                                      | `UserSettings.adversarialReviewConcurrency Int @default(3)`                                                                                   |
| Settings      | `src/backend/trpc/user-settings.trpc.ts`, settings accessor/service, data backup schema                 | carry the new field. The export schema (`src/shared/schemas/export-data.schema.ts`) already lists reviewer fields.                            |
| Admin UI      | `src/client/routes/admin/AdversarialReviewSection.tsx`                                                  | concurrency input                                                                                                                             |
| Orchestration | `src/backend/orchestration/adversarial-review.orchestrator.ts`                                          | try/throw split, queue + dequeue loop, per-child serialization, batch expansion over PRs, outcome type, parent notification, checkout context |
| Orchestration | `src/backend/orchestration/adversarial-review-checkout-context.ts` (new)                                | classify `checked_out` / `fetched_head` / `diff_only`, fetch + clean up the private ref                                                       |
| Prompt        | `prompts/adversarial-review/dispatch.md`, `src/backend/prompts/adversarial-review-dispatch.ts`          | `{{CHECKOUT_CONTEXT}}` section per context                                                                                                    |
| App context   | `src/backend/app-context.ts`                                                                            | expose `triggerChildAdversarialReviews` and `getAdversarialReviewStatus`                                                                      |
| tRPC          | `src/backend/trpc/adversarial-review.trpc.ts`                                                           | `triggerForChildren` mutation. `trigger` may return `queued`.                                                                                 |
| tRPC          | `src/backend/trpc/workspace/children.trpc.ts`                                                           | `agent` (status reason computed without review sessions) and `reviews` per child                                                              |
| Shared        | `src/shared/adversarial-review.ts`                                                                      | `isAdversarialReviewSession` predicate                                                                                                        |
| MCP           | `src/backend/mcp/workspace-mcp-server.ts`                                                               | `run_child_adversarial_reviews` and `list_child_workspaces`                                                                                   |
| Client        | `src/client/features/workspace/child-workspaces-panel.tsx`                                              | **Review children** button, `ConfirmDialog`, toast, header summary, agent status line, review lines with session links, adaptive polling      |
| Client        | `src/client/features/workspace/child-workspace-row.tsx` (new)                                           | row component pulled out of the panel, sharing tone styles with `KanbanStatusChip`                                                            |
| Client        | `adversarial-review-button.tsx`, `use-workspace-pr-actions.ts`                                          | handle the `queued` result in toasts                                                                                                          |
| Docs          | `docs/architecture/agent-runtime.md` (Child workspaces), `docs/design/adversarial-review.md`, this file | describe the tool, panel action, queue, checkout contexts and completion mail once shipped                                                    |

No new capsule or `registry.ts` dependency: the orchestrator already imports
`session`, `workspace`, `settings` and `github` through their barrels, and
orchestration-to-orchestration imports such as
`workspace-notification-delivery.orchestrator` already happen in
`workspace-children.orchestrator.ts`. Git commands in the worktree go through
the existing git helpers used by orchestration, not raw `child_process` calls in
the orchestrator.

---

## Implementation plan

1. **Checkout context first.** Classification, fetch-to-private-ref, prompt
   variants. This fixes the existing per-PR review bug on its own and is worth
   shipping separately.
2. **Refactor the single trigger** into try/throw forms and the
   outcome-returning turn. Existing behavior stays the same apart from the new
   `queued` status.
3. **Queue**: global limit (constant to start), one review per child at a time,
   session created at dequeue, idempotency covering the queue.
4. **Concurrency setting**: Prisma field, migration, settings plumbing, Admin
   input.
5. **Batch orchestrator** expanding children × PRs, plus `triggerForChildren`
   and AppContext wiring.
6. **Parent completion mail** and the recent-outcome map.
7. **Child status**: `getAdversarialReviewStatus`, the `agent` and `reviews`
   fields on `listChildren` with review sessions excluded from agent status. The
   agent-status half doesn't depend on the review work and can ship first.
8. **MCP tools**: `run_child_adversarial_reviews`, `list_child_workspaces`.
9. **UI**: Subagents pane rows (agent line, review lines, header summary,
   session links, adaptive polling), panel button, confirm dialog, toast. Toast
   handling for `queued` in the existing review actions.
10. **Docs**: agent-runtime child-workspace section, the adversarial-review
    record, and mark this record Implemented in `docs/design/README.md`.

### Testing

- Checkout context: same repo + matching branch → `checked_out`. Same repo +
  other branch → `fetched_head`, with the private ref fetched before the turn
  and deleted afterwards (also on failure). Other repo → `diff_only`. A failed
  fetch → `diff_only` with a note. The prompt contains the matching
  `{{CHECKOUT_CONTEXT}}` text. Branch names and SHAs are fenced.
- `tryEnqueueAdversarialReview` returns each `skipped` reason. The throwing
  wrapper still produces today's error messages.
- Queue: with a limit of 3, and with 4 children having 1, 1, 2 and 3 PRs, at
  most 3 reviews run at once and never 2 for the same child. Each child's PRs
  run in ID order. Jobs for other children overtake a blocked child. A failed
  turn frees its slot. No session is created for a queued job. A child at the
  session limit at dequeue yields `skipped: session_limit` and a parent mail.
  Re-queuing a queued or running PR returns `already_active` and merges
  `notifyParent`.
- Batch: expansion produces a row per PR, with child-level rows for no worktree
  or no PRs. MERGED/CLOSED/NONE PRs are skipped with the right reason. A failure
  thrown for one PR does not stop the others. Non-child and archived IDs are
  rejected. When `childWorkspacesEnabled` is false, the batch throws.
- Completion mail: one mail per parent-requested PR, with the right kind and
  subject for each outcome. No mail for reviews started inside the child, unless
  a later batch picked them up. Flags are cleared in `finally`.
- MCP: listed only for parents with child workspaces enabled. Rejected for
  children. Results render grouped by child. Error paths return `isError: true`.
- `listChildren` agent status: a child whose only working session is an
  adversarial review reports `isWorking: false` and its idle reason. A child
  with a working Ratchet fixer still reports it. A pending permission on the
  child's own session gives `NEEDS_PERMISSION`. `workspace.get` for the same
  child is unchanged.
- `getAdversarialReviewStatus`: queued jobs report global positions. Running
  sessions report their session ID, reviewer and context. Recent outcomes appear
  after the turn, expire after 24 hours, and are replaced when a new review of
  the PR starts. PRs no longer attached are dropped. No finding bodies are
  returned.
- `list_child_workspaces` renders the agent line and review lines.
- Client: the button is hidden when no child has an open PR. The confirm dialog
  shows the PR and child counts, the reviewer label and the concurrency. The
  toast summarizes the counts. Each row renders the status-reason label and
  tone. Each review state renders the line from the table. Running and finished
  review lines link to `?session=<id>`. The header summary counts are correct.
  Polling switches between 3 seconds and 15 seconds. Existing review actions
  toast `queued`.
- Manual: in a parent with four children, set up one child with two open PRs on
  different branches, one with a PR in a different repo, one with no PR, and one
  with Ratchet on. Ask the parent agent to "run adversarial review on all
  children" and check:
  - the reported rows are correct
  - no more than the configured number of reviews run at once
  - the off-branch PR's transcript shows the reviewer reading files via
    `git show` at the PR head, not from the working tree
  - the cross-repo review is labelled diff-only
  - reviews post to the right PRs
  - Ratchet dispatches a fixer on the Ratchet-enabled child
  - the parent receives one mail per PR
  - throughout, the parent's Subagents pane shows each child's own agent status
    separately from its per-PR review lines, and clicking a running review opens
    its transcript in the child

---

## Open questions

None remaining.

Resolved:

- **Can the reviewer run `git show` in plan mode?** ✅ Yes, on both Claude and
  Codex. `fetched_head` reviews read the PR head directly. The prompt does not
  include changed-file contents.
- **Notify for all child reviews?** ✅ No. Only reviews the parent requested
  send mail (section 4). A review started from inside a child sends no parent
  mail unless a later batch picks it up as `already_active`.
- **Retrying jobs skipped at the session limit.** ✅ Drop and notify (section
  3). The parent can re-run the batch, which skips work that is already done.
- **Workspace-wide review exclusion.** ✅ Excluded; see Non-goals.
- **Nested provider sub-agents of children.** ✅ Excluded; see Non-goals.
- **Queue behavior.** ✅ Accepted as designed in section 3: a configurable
  global limit, one review per child at a time, and sessions created only when a
  job is dequeued.
- **Reviewing every open PR on a child.** ✅ Required. The batch expands to
  every attached open PR, a child's PRs are reviewed one at a time, and each PR
  is reviewed against its own code (section 5).
