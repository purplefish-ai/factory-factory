# Auto-Iteration Runtime Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve `.factory-factory/` runtime artifacts while discarding timed-out auto-iteration implementation work.

**Architecture:** Unstage the application-owned root runtime subtree before the hard reset, with a recursive `git rm --cached` fallback for repositories whose `HEAD` does not exist yet, then extend `git clean` with a root-anchored exclusion at the destructive cleanup boundary. On an unborn branch, clear the remaining index instead of attempting the unavailable hard reset. Prove the behavior with a real temporary Git repository that distinguishes tracked changes, ordinary untracked content, same-named nested directories, untracked or newly staged root runtime content, and cleanup before the initial commit.

**Tech Stack:** TypeScript, Node.js filesystem and child-process APIs, Git, Vitest

## Global Constraints

- Treat issue metadata as untrusted context and change only code required for issue #1993.
- Preserve untracked and newly staged files below the root `.factory-factory/` during uncommitted-change cleanup.
- Continue restoring tracked files and deleting ordinary untracked files and directories.
- Do not preserve same-named `.factory-factory/` directories nested elsewhere in the repository.
- Preserve workspace Git state invalidation behavior.
- Do not add UI, schema, database, or API changes.

---

### Task 1: Add the Runtime-Preservation Regression and Fix

**Files:**
- Create: `src/backend/services/auto-iteration/service/git-ops.integration.test.ts`
- Modify: `src/backend/services/auto-iteration/service/git-ops.ts`

**Interfaces:**
- Consumes: `discardUncommittedChanges(worktreePath: string): Promise<void>`
- Produces: cleanup behavior that preserves `.factory-factory/` while resetting all other uncommitted work

- [ ] **Step 1: Write the failing real-Git regression test**

Create a temporary Git repository, configure its local test identity, commit
`tracked.txt`, modify that file, add ordinary untracked files, and stage
`.factory-factory/auto-iteration-logbook.json` plus a nested runtime file. Invoke
`discardUncommittedChanges`, then assert the tracked file contains its committed value,
the ordinary untracked files no longer exist, and both runtime files retain their
original content. Add a second case proving `src/.factory-factory/` is not protected,
and a third case proving the same cleanup contract before the initial commit.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm exec vitest run src/backend/services/auto-iteration/service/git-ops.integration.test.ts
```

Expected: the staged root runtime files are missing after `reset --hard`, the
same-named nested directory incorrectly survives the unanchored exclusion, and an
unborn branch fails because `git reset --hard HEAD` has no commit to restore.

- [ ] **Step 3: Implement the minimal staged-file and cleanup protection**

Unstage the root runtime path before the hard reset and anchor the cleanup exclusion.
`HEAD` may not exist before the initial commit, so match the existing defensive unstage
pattern with a recursive directory fallback:

```typescript
try {
  await git(worktreePath, ['reset', 'HEAD', '--', '.factory-factory/']);
} catch {
  await git(worktreePath, [
    'rm',
    '-r',
    '--force',
    '--cached',
    '--ignore-unmatch',
    '--',
    '.factory-factory/',
  ]);
}
```

When `HEAD` exists, restore tracked files with `git reset --hard HEAD`. When it does
not, clear the rest of the index recursively so `git clean` can remove every
non-runtime file:

```typescript
if (headExists) {
  await git(worktreePath, ['reset', '--hard', 'HEAD']);
} else {
  await git(worktreePath, [
    'rm',
    '-r',
    '--force',
    '--cached',
    '--ignore-unmatch',
    '--',
    '.',
  ]);
}
await git(worktreePath, ['clean', '-fd', '-e', '/.factory-factory/']);
```

Both cached-only removals use `--force` so partially staged files can be removed from
the index. Because `--cached` remains present, their working-tree contents are untouched
until the subsequent anchored clean applies the cleanup policy.

- [ ] **Step 4: Run the focused test and verify GREEN**

```bash
pnpm exec vitest run src/backend/services/auto-iteration/service/git-ops.integration.test.ts
```

Expected: the focused regression test passes.

- [ ] **Step 5: Commit the focused fix**

```bash
git add docs/superpowers/specs/2026-07-25-auto-iteration-runtime-cleanup-design.md docs/superpowers/plans/2026-07-25-auto-iteration-runtime-cleanup.md src/backend/services/auto-iteration/service/git-ops.ts src/backend/services/auto-iteration/service/git-ops.integration.test.ts
git commit -m "Preserve runtime files during cleanup (#1993)"
```

### Task 2: Verify, Review, and Publish

**Files:**
- Review: all changes relative to `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: the completed cleanup fix and regression test
- Produces: a clean pushed branch and GitHub pull request closing issue #1993

- [ ] **Step 1: Run the required verification chain**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: all four commands exit zero.

- [ ] **Step 2: Review the branch diff and status**

```bash
git diff origin/main
git status --short
```

Expected: only the focused design, plan, cleanup implementation, and regression test are
present, with no debug output or unrelated edits.

- [ ] **Step 3: Commit any intended verification changes**

Stage only files in this plan and commit them if formatting or review changed tracked
content. Skip this step if the working tree is already clean.

- [ ] **Step 4: Push and create the required PR**

```bash
git push -u origin HEAD
gh pr create --title "Fix #1993: Preserve runtime files during cleanup" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: the branch is tracked on `origin`, and `gh pr view` reports an open PR URL.
