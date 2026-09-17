# Design Doc: Adversarial Review

> **Status:** Implemented. One item (the `COMMENT`-event self-review path,
> including the individual-comments fallback) is confirmed via GitHub API
> research but not yet exercised against a live PR in this repo — worth
> verifying end-to-end after this merges.

## Summary

A toolbar button that triggers a one-off review of a workspace's open PR using a
**different provider/model than the one that built it** — e.g. build with
Claude, review with Codex. The reviewer provider/model is a single Admin-wide
setting, not a per-workspace choice, matching the ask: "configure Codex for
reviewing" once, use it everywhere. The review runs as a normal in-app agent
session (visible transcript) and posts its findings to the PR as **one overall
summary plus inline comments anchored to the specific diff lines they're about**
— i.e. a real GitHub PR review, not a single flat comment.

This is deliberately **read-only**: it produces a critique, it does not edit
code or auto-fix anything. Ratchet already owns "react to review feedback and
fix it"; this feature owns "produce the feedback," using a model with no
authorship stake in the diff — and the two are meant to connect: an adversarial
review that finds real problems should be able to spur Ratchet into fixing them,
the same way a human's changes-requested review does today. See
[Feeding Ratchet](#feeding-ratchet) for how, given that this app's `gh` identity
is also the PR's author, which rules out simply relying on GitHub's native
"request changes" review state (see [Open Questions](#open-questions)).

---

## Context and Motivation

Two related pieces of infrastructure already exist and inform this design:

- **Ratchet** (`docs/architecture/pull-requests.md`) reacts to _incoming_ GitHub
  review feedback (changes-requested reviews, unresolved threads) and dispatches
  a fixer session. It never authors a review itself.
- **`GitHubCLIService.submitReview()`**
  (`src/backend/services/github/service/github-cli.service.ts:596`) wraps
  `gh pr review <number> --approve|--request-changes|--comment`, but its only
  caller today is the human-driven "Reviews" inbox
  (`src/backend/trpc/pr-review.trpc.ts:81`, `src/client/routes/reviews.tsx`). No
  agent session posts a review today.
- An archived design, `docs/design/archive/pr-review-auto-fix-system.md`,
  explored automated PR-review-driven fixing before Ratchet's current
  architecture existed; it's about _reacting to_ reviews, not _producing_ one,
  and is superseded by Ratchet regardless.

The gap: nothing today runs an independent critique of a PR using a model that
didn't write the code. Same-model review (Claude reviewing its own Claude
session's diff) is a known weak spot — the reviewer shares the author's blind
spots. Adversarial Review closes that gap without touching Ratchet's
fix-dispatch machinery.

---

## Goals / Non-goals

**Goals**

- One-click trigger, scoped to a workspace's currently open PR.
- Reviewer provider + model is configured once, in Admin, independent of
  whatever provider built the workspace.
- Read-only: the review session must not edit files, commit, or push.
- Review output is visible in-app immediately, and by default posted to GitHub
  as a single review: one summary + inline comments on the diff lines each
  finding is about.

**Non-goals**

- Auto-fixing findings directly (still Ratchet's job) — this feature only needs
  to make sure Ratchet _notices_ the findings; see
  [Feeding Ratchet](#feeding-ratchet).
- Per-workspace reviewer overrides (Admin-wide only, v1).
- Relying on GitHub's native approve/request-changes review state to signal
  "actionable" — ruled out because the reviewing `gh` identity is the same
  account that authored the PR (see [Open Questions](#open-questions)).
- Continuous/scheduled review (this is on-demand only, unlike Ratchet's poll
  loop).

---

## UX Design

### Admin settings

New card in `src/client/routes/admin/`, e.g. `AdversarialReviewSection.tsx`,
cloned from the existing `ChatProviderDefaultsSection.tsx:16` pattern (which
already does exactly "pick a provider, then a per-provider model/effort select"
for `defaultSessionProvider`/`defaultClaudeModel`/`defaultCodexModel`):

- **Reviewer provider**: `CLAUDE` / `CODEX` select.
- **Reviewer model** (per provider, same live-catalog + fallback pattern as
  `getModelOptions`/`getEffortOptions` in `ChatProviderDefaultsSection.tsx:75`).
- **Post reviews to GitHub** toggle, default **on** (this is the point of the
  feature); turning it off runs the review in-app only, useful for dry-running a
  new reviewer model/prompt without touching the PR.

### Toolbar button

Placed in `src/client/routes/projects/workspaces/workspace-detail-header.tsx`,
next to `RatchetingToggle` (`workspace-detail-header.tsx:217`) — not the
quick-actions menu (`main-view-tab-bar.tsx:391`). Reasoning:

- Quick actions always run on the _currently selected_ chat provider
  (`use-workspace-detail.ts:338-355` forwards `selectedProvider`/
  `selectedModel` verbatim); there's no existing mechanism for a quick action to
  force an Admin-configured provider that overrides the user's current
  selection, and stretching that system to do so would blur its contract.
- This feature is inherently PR-scoped, so it belongs with the other PR-scoped
  controls (`WorkspacePrAction`, `WorkspaceCiStatus`, `RatchetingToggle`), gated
  on the PR being open the same way that UI already is
  (`hasVisiblePullRequest`-style check on `prUrl`/`prNumber`/`prState`).

Button behavior:

- Hidden/disabled when there's no open PR.
- Shows a spinner and is disabled while an adversarial-review session is already
  `RUNNING`/`IDLE` for this workspace; clicking again while active switches to
  that session's tab instead of starting a second one.
- Tooltip shows the configured reviewer, e.g. "Adversarial Review (Codex)".

---

## Data Model Changes

Add to `UserSettings` (`prisma/schema.prisma:588`), mirroring the existing
`defaultSessionProvider`/`defaultClaudeModel`/`defaultCodexModel` fields:

```prisma
reviewerSessionProvider SessionProvider @default(CODEX)
reviewerClaudeModel     String?
reviewerCodexModel      String?
postReviewToGitHub      Boolean @default(true)
```

No new Prisma model needed — this is a singleton settings row, same as every
other Admin default. `AgentSession.workflow` is already a free-form `String`
(`prisma/schema.prisma:557`), so no schema change is needed there; the new
workflow tag `"adversarial_review"` is just a new string value.

---

## Backend Architecture

New capsule: `src/backend/services/adversarial-review/` (`index.ts` +
`service/`), declared in `registry.ts` with dependencies on the `github`,
`session`, and `user-settings` capsules. **No dependency on `ratchet`** — this
is a simpler one-shot flow than `fixerSessionService`'s recurring watcher, so it
gets its own minimal acquire/start logic rather than reusing
`RatchetSessionBridge`/`RatchetWorkspaceBridge`, which are shaped around
Ratchet's restart-on-idle, dispatch-tracking semantics that don't apply here.

### Trigger flow (`adversarialReview.trigger({ workspaceId })` tRPC mutation)

1. Load the workspace's `WorkspacePR`; reject if there's no open PR.
2. Check for an existing session with `workflow: 'adversarial_review'` on this
   workspace in `RUNNING`/`IDLE` status; if found, return its id instead of
   starting a new one (idempotency — same spirit as
   `fixerSessionService.getActiveSession`, minus the restart-on-idle branch).
3. Read `reviewerSessionProvider` / `reviewerClaudeModel` / `reviewerCodexModel`
   from `userSettingsService`.
4. Fetch PR context via existing `GitHubCLIService` methods: `getPRDiff`
   (`github-cli.service.ts:570`) and `getPRFullDetails`
   (`github-cli.service.ts:489`, which includes `headRefOid`, needed as the
   review's `commit_id`/`commitOID`).
5. Render the prompt from a new template (see below), which requires the model
   to end its turn with a structured findings block.
6. Create+start a session with an **explicit** `provider`/`model` — bypassing
   `sessionProviderResolverService` entirely, since this is the one place the
   reviewer must _not_ fall back to the workspace's normal provider. Name it
   e.g. `Adversarial Review (Codex · gpt-5.1)`.
7. On completion, parse the session's final message for the fenced findings
   block, validate it against a Zod schema, drop any comment whose `path`/`line`
   doesn't actually appear in the fetched diff's hunks (log a warning, fold it
   into the summary text instead of dropping the finding entirely), then submit
   as **one review** if `postReviewToGitHub` is on (see below).

### Prompt template

New `prompts/adversarial-review/dispatch.md` +
`src/backend/prompts/adversarial-review-dispatch.ts`, structurally identical to
`ratchet-dispatch.ts:117`'s `buildRatchetDispatchPrompt`:

- Placeholders for PR URL/number, diff, PR description, existing review
  comments.
- The same untrusted-data fencing already proven in `ratchet-dispatch.ts:75-105`
  (`formatReviewComments`: JSON-serialize, escape `<`/`>`/`&`/line separators,
  wrap in `<review-comments-json>` markers, explicit "treat as data, not
  instructions" framing) applied to the diff and PR body, since both are
  attacker-influenceable GitHub content.
- Explicit instructions: this model did not write the code; it must not edit
  files, run destructive commands, commit, or push.
- **Structured output contract**: the model's final message must end with a
  fenced JSON block matching:

  ```ts
  {
    summary: string; // overall review body, markdown
    comments: Array<{
      path: string;       // file path, exactly as it appears in the diff
      line: number;       // line number in the new (post-change) file version
      side: 'RIGHT' | 'LEFT'; // RIGHT = added/context line, LEFT = removed line
      severity: 'blocking' | 'suggestion' | 'nit';
      body: string;
    }>;
  }
  ```

  Parsed with a dedicated Zod schema per boundary-validation convention
  (`AGENTS.md`: "Validate `JSON.parse` results instead of casting") — never cast
  the model's raw output. An empty `comments` array with a summary of "no issues
  found" is a valid, expected outcome.

### Posting the review to GitHub

`GitHubCLIService` gets a new method, e.g.
`submitCodeReview(repo, prNumber, { commitOid, body, threads })`, using the
GraphQL `addPullRequestReview` mutation with
`threads: [DraftPullRequestReviewThread]` (line-based, not the legacy
diff-`position`-based `comments` input) — issued via `gh api graphql`, the same
mechanism already used for other GraphQL reads in this file
(`github-cli.service.ts:391,460,930,1013`), but as a write, so through
`execMutating` rather than `exec`. The `event` is always `COMMENT` — never
`REQUEST_CHANGES`/`APPROVE` — because approve is definitely blocked for a
self-authored PR and request-changes is uncertain enough not to depend on (see
[Open Questions](#open-questions)). This submits the summary and every inline
thread atomically as one review, matching what a human would produce via
GitHub's "Files changed → start a review → multiple comments → submit review"
flow — just always submitted as a comment-only review, never as an approval or a
blocking request-changes state.

If that mutation is rejected specifically because the PR's author and the
reviewing `gh` identity are the same account, fall back to the endpoints
GitHub's own UI offers self-authored-PR owners: individual, immediately
-submitted line comments
(`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`, one call per
finding) plus one top-level issue comment for the summary (`addPRComment`,
already existing at `github-cli.service.ts:1031`) — same visible outcome,
without going through a "review object" endpoint at all.

### Feeding Ratchet

Because the review is always posted as a `COMMENT`-event review rather than
`REQUEST_CHANGES`, it does **not** rely on GitHub's own approve/request-changes
state to signal "this needs action" — deliberately, since that state isn't
available to a self-authored PR's own reviewing identity. Instead:

- The review's summary body is prefixed with a fixed, greppable marker, e.g.
  `<!-- factory-factory:adversarial-review -->`, identifying it as an automated
  adversarial-review finding (as distinct from a human's comment). Because the
  marker text is public on the PR, recognizing it alone would let any GitHub
  user spoof an adversarial-review finding by copying it into their own review;
  the marker only counts if the review's author also matches this app's own
  authenticated `gh` identity (`ratchet-pr-state.helpers.ts`).
- Ratchet's existing "does this PR have actionable review feedback" detection
  (referenced in `docs/architecture/pull-requests.md` as the
  `CHANGES_REQUESTED`/`ALL_REVIEW_FEEDBACK` trigger-mode check, and the
  resolved-thread exclusion logic in the ratchet capsule) gets a small addition:
  a review or unresolved inline thread carrying the marker counts as actionable
  regardless of trigger mode, the same way a human's changes-requested review or
  unresolved thread does today.
- This is a genuine (if small) change to Ratchet's trigger logic, not just new
  code in the new capsule — worth calling out since it touches an existing,
  carefully-scoped area (`docs/architecture/pull-requests.md` is explicit that
  _ordinary_ PR conversation comments never trigger Ratchet; the marker is a
  deliberate, narrow exception for this app's own automated output, not a
  loosening of that rule for arbitrary comments).
- Because inline comments belonging to a _resolved_ review thread are already
  excluded from Ratchet's trigger (existing behavior), once Ratchet's fixer
  addresses a finding and the thread is resolved, it naturally stops being
  actionable — no extra bookkeeping needed on the adversarial-review side.

---

## Open Questions

Resolved during review:

- **Session permissions for a read-only review.** ✅ Resolved: the session
  starts in `plan` startup mode (`adversarial-review.orchestrator.ts`), which
  structurally blocks write tools rather than relying on trusting the prompt —
  unlike Ratchet's fixer, this workflow has no legitimate reason to ever need
  write access, so reusing Ratchet's `YOLO`-by-default permission preset would
  grant it anyway. It also uses `defaultWorkspacePermissions` instead of
  `ratchetPermissions` for the same reason
  (`session-lifecycle-external-ports.ts`).
- **Merge-blocking event type.** ✅ Resolved: always `COMMENT`, never
  `REQUEST_CHANGES`/`APPROVE`. The original plan was to map severity to
  `REQUEST_CHANGES` so Ratchet's native trigger would pick it up "for free," but
  that depends on GitHub allowing a self-authored PR's own identity to request
  changes on it — undermining the whole approach if it turns out to be blocked
  the same way approval is. The marker-based signal in
  [Feeding Ratchet](#feeding-ratchet) gets the same result without depending on
  that.
- **Does the marker bypass the admin's configured Ratchet trigger mode?** ✅
  Resolved: yes, always. A marker-tagged finding is treated as actionable
  whenever Ratchet is enabled for that workspace, regardless of
  `ratchetReviewTriggerMode` — clicking the button is itself an explicit request
  for feedback, unlike ambient human review activity, so it should always get
  acted on rather than filtered by a setting meant to tune sensitivity to
  incidental human comments.
- **Invalid line references.** ✅ Resolved: fold, don't silently drop. The model
  reviews with full file context (to understand a change) but can only leave
  inline comments on lines actually present in the diff, so it will sometimes
  point at a nearby line that wasn't touched, or miscount across hunks in a
  large multi-hunk file. Rather than silently dropping that finding, fold it
  into the review summary with an explicit note that it refers to a line outside
  this PR's diff. That note flows through to Ratchet's fixer dispatch, which
  already has a "reply with the outcome or reason for declining unaddressed
  feedback" policy (`ratchet-dispatch.ts`'s `getReviewPolicy`) — so the fixer
  naturally produces a gentle "this isn't part of the change" pushback on its
  own, without any new mechanism needed on the adversarial-review side.
- **Does a `COMMENT`-event review work on a self-authored PR?** ✅ Resolved via
  API research (not yet empirically re-verified against a live PR in this repo —
  no open PR was available at design time). GitHub's REST/GraphQL review APIs
  block both `APPROVE` and `REQUEST_CHANGES` for a PR's own author — the latter
  fails with the explicit error "Can not request changes on your own pull
  request," per GitHub's docs and confirmed community reports. `COMMENT` carries
  no approval semantics and is the documented escape hatch PR authors are
  expected to use to leave feedback on their own PR, which is exactly why v1
  fixes the event to `COMMENT`. The self-review fallback path (per-line
  comments + one issue comment) is kept in the design as defense-in-depth in
  case of edge cases the docs don't cover, but is no longer expected to be the
  common path.

---

## Affected / New Files

| Area            | File                                                                                          | Change                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema          | `prisma/schema.prisma`                                                                        | +4 fields on `UserSettings`                                                                                                                                     |
| Admin UI        | `src/client/routes/admin/AdversarialReviewSection.tsx`                                        | new, cloned from `ChatProviderDefaultsSection.tsx`                                                                                                              |
| Admin API       | `src/backend/trpc/user-settings.trpc.ts`                                                      | extend `update`'s Zod schema (`:147`)                                                                                                                           |
| Backend capsule | `src/backend/services/adversarial-review/` (`index.ts`, `service/`)                           | new                                                                                                                                                             |
| Prompt          | `prompts/adversarial-review/dispatch.md`                                                      | new                                                                                                                                                             |
| Prompt builder  | `src/backend/prompts/adversarial-review-dispatch.ts`                                          | new, modeled on `ratchet-dispatch.ts`                                                                                                                           |
| Output schema   | `src/backend/services/adversarial-review/service/findings-schema.ts`                          | new — Zod schema for the model's structured findings block                                                                                                      |
| GitHub client   | `src/backend/services/github/service/github-cli.service.ts`                                   | add `submitCodeReview` (GraphQL `addPullRequestReview`, `event: COMMENT`, with threads) + self-review fallback (per-line `pulls/.../comments` + `addPRComment`) |
| Ratchet trigger | `src/backend/services/ratchet/` (actionable-feedback detection)                               | recognize the adversarial-review marker as actionable, alongside the existing changes-requested/unresolved-thread checks                                        |
| Toolbar         | `src/client/routes/projects/workspaces/workspace-detail-header.tsx`                           | add button next to `RatchetingToggle` (`:217`)                                                                                                                  |
| Toolbar button  | `src/client/routes/projects/workspaces/workspace-detail-header/adversarial-review-button.tsx` | new                                                                                                                                                             |
| Registry        | `src/backend/services/registry.ts`                                                            | declare new capsule + deps                                                                                                                                      |

---

## Implementation Plan

1. **Schema + Admin settings**: Prisma fields, `userSettings.update` schema,
   `AdversarialReviewSection.tsx`.
2. **Backend capsule**: trigger service (idempotency check, provider/model
   resolution, session creation with explicit provider/model bypassing the
   normal resolver), prompt template + builder with untrusted-data fencing and
   the structured-output contract, Zod schema for parsing the model's findings
   block.
3. **GitHub posting**: `submitCodeReview` (GraphQL `addPullRequestReview`,
   `event: COMMENT`, with threads, marker-prefixed summary body) on
   `GitHubCLIService`, diff-hunk validation to drop out-of-diff comment targets,
   and the self-review fallback path (per-line comments + one issue comment).
4. **Ratchet trigger update**: small addition to the ratchet capsule's
   actionable-feedback detection to recognize the marker.
5. **Toolbar**: button component, PR-open gating, active-session
   spinner/disable/switch-to-tab behavior, tRPC mutation wiring.
6. **Sanity-check the `COMMENT`-event self-review path** against a real PR early
   in implementation (confirmed via API research, not yet exercised live in this
   repo) — since it determines whether the primary path or the fallback path is
   what most users actually see.

### Testing

- Unit tests for the prompt builder's untrusted-data escaping (same shape as
  existing `ratchet-dispatch.ts` tests).
- Unit tests for the findings-block Zod schema: valid payload parses; missing
  fields, wrong `side`/`severity` enum values, and non-JSON trailing content are
  all rejected without throwing an uncaught exception.
- Unit test for diff-hunk validation: a comment whose `path`/`line` isn't in the
  fetched diff is dropped and folded into the summary rather than causing the
  whole submission to fail.
- Unit test for the idempotency check (existing active session → returns
  existing id, no duplicate session created).
- Unit test asserting explicit provider/model bypasses
  `sessionProviderResolverService` (reviewer session provider must not follow
  the workspace's default even when they'd normally resolve differently).
- Unit test for `submitCodeReview`'s self-review fallback: mock the GraphQL
  mutation rejecting with the self-review error, assert it degrades to the
  per-line-comments + issue-comment path instead of throwing.
- Unit test for the Ratchet trigger update: a marker-tagged review/unresolved
  thread is treated as actionable even when it wouldn't otherwise qualify under
  the workspace's configured trigger mode; a marker-tagged comment belonging to
  a _resolved_ thread is still excluded, same as today.
- Manual verification: trigger a review on a real open PR with reviewer set to a
  different provider than the workspace's session provider; confirm the
  transcript shows the configured reviewer model, the worktree is unchanged
  afterward, the PR shows a review (or, if the self-review restriction bites,
  the fallback comments) with inline comments landing on the right lines, and —
  with Ratchet enabled on that workspace — a fixer session gets dispatched off
  the marker without needing a native GitHub request-changes state.
