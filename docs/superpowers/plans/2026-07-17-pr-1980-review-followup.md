# PR 1980 Review Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the latest `main` branch into PR #1980 and address every unresolved actionable review comment with stable regression coverage.

**Architecture:** Preserve the existing startup-delivery deduplication fix, which already rechecks the in-memory queue after transcript reconciliation. Replace the brittle workspace-router composition assertion with successful calls through the public tRPC caller using partial module mocks for one procedure from each merged router segment.

**Tech Stack:** TypeScript, tRPC v11, Vitest, pnpm, Git.

## Global Constraints

- Preserve queued fallback, notification deduplication, and UI delta behavior.
- Do not use tRPC internal `_def.procedures` composition.
- Merge `origin/main`; do not rebase or rewrite existing PR commits.
- Do not reply to or resolve GitHub review threads without explicit authorization.

---

### Task 1: Integrate the latest main branch

**Files:**
- Merge: files changed between the current branch and `origin/main`

**Interfaces:**
- Consumes: `origin/main` at the latest fetched commit
- Produces: a merge commit with both histories preserved

- [ ] **Step 1: Confirm the worktree only contains this plan**

Run: `git status --short`
Expected: only this plan is untracked before staging, with no unrelated user changes.

- [ ] **Step 2: Fetch the latest base branch**

Run: `git fetch origin main`
Expected: `origin/main` is updated from the remote repository.

- [ ] **Step 3: Merge the fetched base branch**

Run: `git merge --no-edit origin/main`
Expected: a clean merge, or conflicts limited to files changed by both branches.

- [ ] **Step 4: Resolve and inspect any merge conflicts**

Run: `git diff --check && git status --short`
Expected: no unmerged paths and no whitespace errors.

### Task 2: Stabilize the public caller composition test

**Files:**
- Modify: `src/backend/trpc/workspace/composition.test.ts`
- Test: `src/backend/trpc/workspace/composition.test.ts`

**Interfaces:**
- Consumes: `workspaceRouter.createCaller(Context)`
- Produces: successful calls to `list`, `getPendingNotificationCount`, and `listAllFiles`

- [ ] **Step 1: Run the current test as the brittle baseline**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/trpc/workspace/composition.test.ts`
Expected: PASS while relying on invalid inputs and `BAD_REQUEST` errors.

- [ ] **Step 2: Replace invalid calls with valid public caller behavior**

Add partial Vitest mocks for `workspaceDataService.findByProjectId`, `workspaceNotificationAccessor.countPending`, and `getWorkspaceWithWorktree`. Create the caller with a real `createLogger` stub, invoke valid inputs, and assert these results:

```ts
await expect(caller.list({ projectId: 'project-1' })).resolves.toEqual([]);
await expect(
  caller.getPendingNotificationCount({ workspaceId: 'workspace-1' })
).resolves.toBe(0);
await expect(
  caller.listAllFiles({ workspaceId: 'workspace-1', limit: 50 })
).resolves.toEqual({ files: [], hasWorktree: false });
```

- [ ] **Step 3: Run the focused router tests**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/trpc/workspace/composition.test.ts src/backend/trpc/workspace/children.router.test.ts src/backend/trpc/workspace.router.test.ts`
Expected: all selected test files pass.

### Task 3: Verify, commit, push, and re-fetch review state

**Files:**
- Verify: all tracked changes in the branch

**Interfaces:**
- Consumes: merged base and stable composition test
- Produces: pushed branch at a clean, verified commit

- [ ] **Step 1: Run full repository verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`
Expected: exit code 0 for every command.

- [ ] **Step 2: Inspect and commit the final diff**

Run: `git diff --check && git status --short && git diff --stat origin/main...HEAD`
Expected: no whitespace errors or unrelated changes.

Run: `git add docs/superpowers/plans/2026-07-17-pr-1980-review-followup.md && git commit -m "Fix PR review follow-up plan (#1960)"`
Expected: commit hooks pass and a focused commit is created.

- [ ] **Step 3: Push and re-fetch PR review threads**

Run: `git push`
Expected: the remote PR branch advances without force-pushing.

Run: `python /Users/martin/.codex/plugins/cache/openai-curated-remote/github/0.1.8-2841cf9749ae/skills/gh-address-comments/scripts/fetch_comments.py`
Expected: the composition-test thread is outdated or resolved; the earlier race thread remains code-addressed by its regression test.
