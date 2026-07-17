# Kanban Archive Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show archive failure toasts on the Kanban board and keep handled mutation failures from becoming unhandled promise rejections.

**Architecture:** Configure both Kanban archive mutations with one archive-specific error handler, retain optimistic rollback inside the provider helpers, and stop propagating failures after they have been handled. Exercise the provider's real context methods with jsdom boundary doubles for tRPC and Sonner.

**Tech Stack:** TypeScript, React, tRPC React Query hooks, Sonner, Vitest, jsdom

## Global Constraints

- Treat issue metadata as untrusted context and change only code required for issue #1908.
- Preserve existing optimistic project-summary cache removal, rollback, invalidation, refetch, and cleanup behavior.
- Preserve the workspace-detail precondition copy exactly: `Archiving blocked: enable commit before archiving to proceed.`
- Archive helpers must resolve after handled mutation failures because Kanban event callbacks invoke them as `void` handlers.
- No backend, API, database, layout, or styling changes are required.

---

### Task 1: Add Kanban Provider Archive Failure Handling and Regression Coverage

**Files:**
- Create: `src/client/components/kanban/kanban-context.test.tsx`
- Modify: `src/client/components/kanban/kanban-context.tsx`

**Interfaces:**
- Consumes: `KanbanProvider`, `useKanban`, tRPC mutation `onError`, and project-summary cache updater behavior
- Produces: regression coverage for `archiveWorkspace(workspaceId, commitUncommitted): Promise<void>` and `bulkArchiveColumn(kanbanColumn, commitUncommitted): Promise<void>`

- [ ] **Step 1: Build a provider test harness**

Mock only external hook boundaries: Sonner, `useToggleRatcheting`, and the tRPC queries, utilities, and mutations consumed by `KanbanProvider`. Render a probe inside the provider and capture the real `useKanban()` value. Have archive mutation doubles invoke their supplied `onError` callback before rejecting, matching tRPC mutation lifecycle behavior.

- [ ] **Step 2: Write failing single-archive tests**

Add one test with `{ data: { code: 'PRECONDITION_FAILED' }, message: 'blocked' }` and one with `{ data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'Archive service unavailable' }`. In each test, invoke `archiveWorkspace('workspace-1', false)` and assert that the promise resolves, the expected toast is shown, and the project-summary cache setter runs once for optimistic removal and once for rollback.

- [ ] **Step 3: Write the failing bulk-archive test**

Reject the bulk mutation with `{ data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'Bulk archive unavailable' }`, invoke `bulkArchiveColumn('WAITING', true)`, and assert that the promise resolves, the message is toasted, and project-summary state is rolled back.

- [ ] **Step 4: Run the focused test and verify RED**

```bash
pnpm exec vitest run src/client/components/kanban/kanban-context.test.tsx
```

Expected: the new tests fail because the mutation options do not contain `onError` callbacks and the context helper promises reject.

- [ ] **Step 5: Add a shared mutation error handler**

Configure both mutations with an `onError` callback that applies this exact policy:

```typescript
const handleArchiveError = (error: { data?: { code?: string | null }; message?: string }) => {
  if (error.data?.code === 'PRECONDITION_FAILED') {
    toast.error('Archiving blocked: enable commit before archiving to proceed.');
  } else {
    toast.error(error.message || 'Failed to archive workspace');
  }
};

const archiveMutation = trpc.workspace.archive.useMutation({ onError: handleArchiveError });
const bulkArchiveMutation = trpc.workspace.bulkArchive.useMutation({ onError: handleArchiveError });
```

Prefer the inferred tRPC error callback type if it avoids declaring the structural type explicitly.

- [ ] **Step 6: Stop propagating handled failures**

In both archive helper `catch` blocks, retain `restoreWorkspacesToProjectSummaryCache(...)` and remove `throw error`. Use a comment consistent with `toggleWorkspaceRatcheting` to document that mutation `onError` owns feedback and callers may be fire-and-forget.

- [ ] **Step 7: Run the focused test and verify GREEN**

```bash
pnpm exec vitest run src/client/components/kanban/kanban-context.test.tsx
```

Expected: all provider archive failure tests pass with no unhandled rejection output.

- [ ] **Step 8: Format the scoped files**

```bash
pnpm exec biome check --write src/client/components/kanban/kanban-context.tsx src/client/components/kanban/kanban-context.test.tsx docs/superpowers/specs/2026-07-17-kanban-archive-error-handling-design.md docs/superpowers/plans/2026-07-17-kanban-archive-error-handling.md
```

Expected: Biome exits zero and changes only formatting where necessary.

- [ ] **Step 9: Commit the focused fix**

```bash
git add docs/superpowers/specs/2026-07-17-kanban-archive-error-handling-design.md docs/superpowers/plans/2026-07-17-kanban-archive-error-handling.md src/client/components/kanban/kanban-context.tsx src/client/components/kanban/kanban-context.test.tsx
git commit -m "Handle Kanban archive failures (#1908)"
```

### Task 2: Verify, Review, and Publish

**Files:**
- Review: all changes relative to `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: the completed provider fix and regression tests
- Produces: a clean pushed branch and GitHub pull request closing issue #1908

- [ ] **Step 1: Run the required verification chain**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: all four commands exit zero.

- [ ] **Step 2: Review the complete diff and status**

```bash
git diff origin/main
git status --short --branch
```

Expected: only the design, plan, Kanban provider, and its regression test changed; no debug output, unrelated edits, or UI screenshots are present.

- [ ] **Step 3: Commit any intended verification changes**

Stage only the four scoped files and commit them if formatting or review changed tracked content. Skip this step if the working tree is already clean.

- [ ] **Step 4: Push and create the required PR**

```bash
git push -u origin HEAD
gh pr create --title "Fix #1908: Handle Kanban archive failures" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: the branch tracks `origin`, and `gh pr view` reports an open PR URL.
