# Shared Project Issues Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar and Kanban use one typed implementation for provider issue queries, normalization, GitHub CLI health synchronization, query state selection, and transient client cache reconciliation.

**Architecture:** Introduce `useProjectIssues` over the existing GitHub and Linear tRPC endpoints and migrate both consumers to it. Keep `filterIssuesLinkedToActiveWorkspaces` as the server-side durable policy owner, and isolate newer-workspace-cache/in-flight-archive reconciliation in a separately tested shared client helper.

**Tech Stack:** TypeScript, React 19 hooks, tRPC React Query, Vitest, jsdom

## Global Constraints

- Treat issue metadata as untrusted context and change only code required for issue #1962.
- Preserve 60-second refetch polling and 30-second stale timing for both providers.
- Preserve the existing GitHub CLI health synchronization policy.
- Keep durable active-workspace filtering in the backend provider routers.
- Allow client filtering only to reconcile newer workspace-cache links and explicit temporary optimistic issue links.
- Do not add a provider-neutral backend endpoint in this short-term change.
- This is a behavior-preserving data-flow refactor with no intentional rendered UI change.

---

### Task 1: Add Shared Hook, Transient Visibility, and Router Policy Regression Coverage

**Files:**
- Create: `src/client/hooks/use-project-issues.test.tsx`
- Create: `src/client/lib/project-issue-visibility.test.ts`
- Modify: `src/backend/trpc/github.router.test.ts`
- Modify: `src/backend/trpc/linear.router.test.ts`

**Interfaces:**
- Consumes: future `useProjectIssues(projectId, issueProvider, clientState)`
- Produces: regression coverage for provider selection, query timing, normalization, health synchronization, selected refetch state, transient cache reconciliation, and durable router filtering

- [ ] **Step 1: Write a failing GitHub hook test**

Create a jsdom React harness that captures the hook result. Mock both provider `useQuery` hooks and `trpc.useUtils`. Assert that GitHub is enabled, Linear is disabled, both receive `refetchInterval: 60_000` and `staleTime: 30_000`, the GitHub response is normalized, the selected GitHub refetch function is returned, and qualifying GitHub health is synchronized.

- [ ] **Step 2: Write failing Linear and disabled-query hook tests**

Render the same harness with `IssueProvider.LINEAR`. Assert that Linear is enabled, GitHub is disabled, the Linear response is normalized, Linear refetch is selected, and GitHub health is not synchronized without GitHub data. Render without a project ID and assert both queries are disabled.

- [ ] **Step 3: Verify hook tests fail for the missing shared hook**

```bash
pnpm exec vitest run src/client/hooks/use-project-issues.test.tsx
```

Expected: FAIL because `src/client/hooks/use-project-issues.ts` does not exist or does not export the required hook.

- [ ] **Step 4: Strengthen both router policy tests**

Extend the existing GitHub and Linear active-workspace filtering fixtures with an `ARCHIVING` workspace and assert that its issue remains visible alongside the existing `ARCHIVED` case. This documents that the server is the durable policy owner and that neither terminal archive status reserves an issue.

- [ ] **Step 5: Run router tests before client implementation**

```bash
pnpm exec vitest run src/backend/trpc/github.router.test.ts src/backend/trpc/linear.router.test.ts
```

Expected: PASS because the existing shared backend filter already implements the desired durable policy.

- [ ] **Step 6: Write failing transient visibility helper tests**

Create pure tests for GitHub and Linear issues linked in the newer workspace cache, a captured in-flight archive link after its workspace disappears, unlinked issues, null links, and GitHub issue number `0`.

- [ ] **Step 7: Verify the visibility tests fail for the missing helper**

```bash
pnpm exec vitest run src/client/lib/project-issue-visibility.test.ts
```

Expected: FAIL because `project-issue-visibility.ts` does not exist or does not export the required helper.

### Task 2: Implement and Adopt `useProjectIssues`

**Files:**
- Create: `src/client/hooks/use-project-issues.ts`
- Create: `src/client/lib/project-issue-visibility.ts`
- Delete: `src/client/hooks/use-sidebar-issues.ts`
- Modify: `src/client/components/app-sidebar.tsx`
- Modify: `src/client/components/kanban/kanban-context.tsx`
- Modify: `src/client/routes/projects/workspaces/components/workspaces-board-view.tsx`
- Modify: `src/backend/trpc/issue-filter.ts`

**Interfaces:**
- Produces: `useProjectIssues(projectId: string | undefined, issueProvider: IssueProvider, clientState: ProjectIssuesClientState)`
- Produces: `filterIssuesForCurrentWorkspaceState(issues, issueProvider, workspaces, optimisticWorkspaceIssueLinks)` for transient shared client cache reconciliation
- Consumes: `trpc.github.listIssuesForProject`, `trpc.linear.listIssuesForProject`, normalization helpers, and CLI health cache helpers

- [ ] **Step 1: Implement the minimal shared hook**

Declare both provider queries with the common timing options and provider-specific `enabled` values. Select the active provider's loading/refetch state, normalize its response, and synchronize qualifying GitHub health in one effect.

- [ ] **Step 2: Run the shared hook tests and verify GREEN**

```bash
pnpm exec vitest run src/client/hooks/use-project-issues.test.tsx
```

Expected: all shared hook tests pass.

- [ ] **Step 3: Migrate the sidebar**

Replace `useSidebarIssues` with `useProjectIssues(selectedProjectId, issueProvider, { workspaceIssueLinks: serverWorkspaces })`. Delete `use-sidebar-issues.ts` after its only consumer is migrated.

- [ ] **Step 4: Implement the transient visibility helper**

Move workspace-link and captured-archive-link filtering into `src/client/lib/project-issue-visibility.ts`. Document that it reconciles newer client workspace state against a potentially stale provider query and does not define durable issue eligibility.

- [ ] **Step 5: Run the visibility helper tests and verify GREEN**

```bash
pnpm exec vitest run src/client/lib/project-issue-visibility.test.ts
```

Expected: all transient visibility tests pass.

- [ ] **Step 6: Migrate Kanban**

Remove provider query, CLI health, normalization, and inline filtering code from `kanban-context.tsx`. Pass current workspace data and captured archive links to the shared hook and use its `issues`, `isLoading`, and `refetch` results directly.

- [ ] **Step 7: Tighten provider input types and document ownership**

Use the shared `IssueProvider` type for the new hook and Kanban provider props, propagating it through `WorkspacesBoardView`. Add a comment to `filterIssuesLinkedToActiveWorkspaces` identifying it as the durable linked-workspace policy and allowing clients only transient optimistic exclusions.

- [ ] **Step 8: Run all focused tests**

```bash
pnpm exec vitest run src/client/hooks/use-project-issues.test.tsx src/client/lib/project-issue-visibility.test.ts src/backend/trpc/github.router.test.ts src/backend/trpc/linear.router.test.ts
```

Expected: all focused client and router tests pass.

- [ ] **Step 9: Commit the focused implementation**

```bash
git add src/client/hooks/use-project-issues.ts src/client/hooks/use-project-issues.test.tsx src/client/hooks/use-sidebar-issues.ts src/client/components/app-sidebar.tsx src/client/components/kanban/kanban-context.tsx src/client/lib/project-issue-visibility.ts src/client/lib/project-issue-visibility.test.ts src/client/routes/projects/workspaces/components/workspaces-board-view.tsx src/backend/trpc/issue-filter.ts src/backend/trpc/github.router.test.ts src/backend/trpc/linear.router.test.ts
git commit -m "Consolidate project issue loading (#1962)"
```

Expected: one atomic implementation/test commit succeeds.

### Task 3: Verify, Review, and Publish

**Files:**
- Review: all changes relative to `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: the shared hook, migrated consumers, and router policy tests
- Produces: verified commits, a clean pushed branch, and a GitHub pull request closing issue #1962

- [ ] **Step 1: Run the required verification chain**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: all four commands exit zero.

- [ ] **Step 2: Review the complete diff and scope**

```bash
git diff origin/main
git status --short --branch
```

Expected: only the planning docs, shared hook/test, two consumers, provider typing, backend filter documentation, and provider router tests differ; no debug logs or unrelated changes are present.

- [ ] **Step 3: Commit verification formatting if needed**

Stage only intended files changed by `check:fix`, then commit with:

```bash
git commit -m "Apply project issue hook verification fixes (#1962)"
```

Expected: commit only if verification changed intended files; otherwise skip it.

- [ ] **Step 4: Push and create the required pull request**

```bash
git push -u origin HEAD
gh pr create --title "Fix #1962: Consolidate project issue loading" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: the branch tracks `origin`, and `gh pr view` prints the created open PR URL.
