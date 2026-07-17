# Centralized Workspace Git State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace overlapping workspace Git scans with a watcher-invalidated, single-flight snapshot shared by backend reconciliation, queries, and visible UI panels.

**Architecture:** A process-global `WorkspaceGitStateService` caches sectioned snapshots by normalized worktree path and default branch. It watches worktree and linked Git metadata, uses a five-minute fallback expiry when watching fails, and exposes explicit invalidation/eviction for app-owned mutations and worktree cleanup.

**Tech Stack:** TypeScript, Node `fs.watch`, Express/tRPC, React Query, Vitest

## Global Constraints

- Preserve existing tRPC endpoint response shapes and section-specific error behavior.
- Keep per-file diffs on demand; only reuse the shared merge base.
- A healthy watcher gives warm entries no time-based expiry; watcher fallback expires after 300,000 ms.
- A visible changes panel refreshes every 15,000 ms; hidden panels and archive guards do not poll continuously.
- Cache keys include normalized worktree path and default branch.
- Invalidation during an in-flight calculation must prevent the old result from repopulating the cache.

---

### Task 1: Single-flight Git snapshot core

**Files:**
- Create: `src/backend/services/workspace-git-state.service.ts`
- Create: `src/backend/services/workspace-git-state.service.test.ts`
- Modify: `src/backend/lib/git-helpers.ts`
- Modify: `src/backend/lib/git-helpers.test.ts`

**Interfaces:**
- Consumes: `gitCommand(args: string[], cwd: string): Promise<ExecResult>`, `parseGitStatusOutput`, and `parseNumstatOutput`.
- Produces: `workspaceGitStateService.getSnapshot(input)`, `invalidate(worktreePath)`, `remove(worktreePath)`, `stop()`, `WorkspaceGitStateSnapshot`, and `getStats(snapshot)`.

- [ ] **Step 1: Write failing parser and service tests**

Add tests proving numstat produces all aggregate fields and defining the snapshot API:

```ts
it('derives additions, deletions, and file count from one numstat output', () => {
  expect(parseNumstatOutput('2\t1\ta.ts\n-\t-\timage.png\n')).toEqual({
    total: 2,
    additions: 2,
    deletions: 1,
  });
});

it('shares one calculation for concurrent requests and reuses the warm result', async () => {
  const first = service.getSnapshot({ worktreePath: '/repo/w1', defaultBranch: 'main' });
  const second = service.getSnapshot({ worktreePath: '/repo/w1', defaultBranch: 'main' });
  expect(await second).toBe(await first);
  await service.getSnapshot({ worktreePath: '/repo/w1', defaultBranch: 'main' });
  expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(1);
});

it('does not cache a calculation invalidated while it is in flight', async () => {
  const first = service.getSnapshot({ worktreePath: '/repo/w1', defaultBranch: 'main' });
  service.invalidate('/repo/w1');
  await first;
  await service.getSnapshot({ worktreePath: '/repo/w1', defaultBranch: 'main' });
  expect(runGit.mock.calls.filter(([args]) => args[0] === 'status')).toHaveLength(2);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run src/backend/lib/git-helpers.test.ts src/backend/services/workspace-git-state.service.test.ts`

Expected: FAIL because the new service and `total` parser field do not exist.

- [ ] **Step 3: Implement the minimal sectioned snapshot and cache generation logic**

Define the public shape and core methods:

```ts
export interface WorkspaceGitStateSnapshot {
  worktreePath: string;
  defaultBranch: string;
  computedAt: number;
  status: { files: GitStatusFile[]; hasUncommitted: boolean; error?: string };
  base: {
    mergeBase: string | null;
    noMergeBase: boolean;
    stats: { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null;
    added: Array<{ path: string; status: 'added' }>;
    modified: Array<{ path: string; status: 'modified' }>;
    deleted: Array<{ path: string; status: 'deleted' }>;
    error?: string;
  };
  upstream: { ref: string | null; hasUpstream: boolean; files: string[]; error?: string };
}

getSnapshot(input: WorkspaceGitStateInput): Promise<WorkspaceGitStateSnapshot> {
  const key = this.cacheKey(input);
  const cached = this.cache.get(key);
  if (cached && !this.isExpired(input.worktreePath, cached)) return Promise.resolve(cached.snapshot);
  const existing = this.inFlight.get(key);
  if (existing) return existing;
  const generation = this.generations.get(key) ?? 0;
  const calculation = this.calculate(input).then((snapshot) => {
    if ((this.generations.get(key) ?? 0) === generation) this.cache.set(key, { snapshot });
    return snapshot;
  }).finally(() => this.inFlight.delete(key));
  this.inFlight.set(key, calculation);
  return calculation;
}
```

Use `diff --numstat <mergeBase>` for total/additions/deletions and `diff --name-status <mergeBase>` for metadata. Try `origin/<defaultBranch>` then `<defaultBranch>` for the merge base. Treat a failed upstream `rev-parse` as no upstream; record other command failures only in their relevant section.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/backend/lib/git-helpers.test.ts src/backend/services/workspace-git-state.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the snapshot core**

```bash
git add src/backend/lib/git-helpers.ts src/backend/lib/git-helpers.test.ts src/backend/services/workspace-git-state.service.ts src/backend/services/workspace-git-state.service.test.ts
git commit -m "Centralize workspace Git snapshots (#1943)"
```

### Task 2: Watchers, fallback expiry, and lifecycle eviction

**Files:**
- Modify: `src/backend/services/workspace-git-state.service.ts`
- Modify: `src/backend/services/workspace-git-state.service.test.ts`
- Modify: `src/backend/services/git-ops.service.ts`
- Modify: `src/backend/services/git-ops.service.test.ts`
- Modify: `src/backend/services/workspace/service/worktree/worktree-lifecycle.service.ts`
- Modify: `src/backend/services/workspace/service/worktree/worktree-lifecycle.service.test.ts`
- Modify: `src/backend/server.ts`

**Interfaces:**
- Consumes: Node `watch`, the worktree `.git` file, linked `gitdir`, and optional `commondir`.
- Produces: automatic debounced invalidation, five-minute fallback expiry, mutation invalidation, eviction, and watcher shutdown.

- [ ] **Step 1: Write failing watcher and lifecycle tests**

```ts
it('invalidates after a watched file event', async () => {
  const first = await service.getSnapshot(input);
  watchers.get('/repo/w1')?.listener('change', 'src/a.ts');
  await vi.advanceTimersByTimeAsync(100);
  expect(await service.getSnapshot(input)).not.toBe(first);
});

it('uses slow expiry when recursive watcher setup fails', async () => {
  watchPath.mockImplementation(() => { throw new Error('unsupported'); });
  await service.getSnapshot(input);
  now += 299_999;
  await service.getSnapshot(input);
  expect(statusCalls()).toBe(1);
  now += 1;
  await service.getSnapshot(input);
  expect(statusCalls()).toBe(2);
});

it('closes watchers and clears all base variants on remove', async () => {
  await service.getSnapshot({ ...input, defaultBranch: 'main' });
  await service.getSnapshot({ ...input, defaultBranch: 'develop' });
  service.remove(input.worktreePath);
  expect(close).toHaveBeenCalled();
  expect(service.getCachedSnapshotCount()).toBe(0);
});
```

Add Git operation tests asserting successful commit/create invalidates and successful worktree removal evicts; failed operations must not claim success invalidation.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/backend/services/workspace-git-state.service.test.ts src/backend/services/git-ops.service.test.ts src/backend/services/workspace/service/worktree/worktree-lifecycle.service.test.ts`

Expected: FAIL because watcher state and lifecycle hooks are not implemented.

- [ ] **Step 3: Implement watchers and explicit hooks**

Install a watcher record once per normalized path. Parse `.git` as `gitdir: <path>`, resolve optional `commondir`, watch all available roots, and switch the record to fallback mode if setup throws or emits `error`. Debounce callbacks by 100 ms. Add these successful mutation hooks:

```ts
await gitCommand(['commit', '-m', commitMessage, '--no-verify'], worktreePath);
workspaceGitStateService.invalidate(worktreePath);

await gitOpsService.removeWorktree(worktreePath, project);
workspaceGitStateService.remove(worktreePath);
```

Call `workspaceGitStateService.stop()` during server cleanup after snapshot reconciliation stops.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run src/backend/services/workspace-git-state.service.test.ts src/backend/services/git-ops.service.test.ts src/backend/services/workspace/service/worktree/worktree-lifecycle.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit invalidation and lifecycle behavior**

```bash
git add src/backend/services/workspace-git-state.service.ts src/backend/services/workspace-git-state.service.test.ts src/backend/services/git-ops.service.ts src/backend/services/git-ops.service.test.ts src/backend/services/workspace/service/worktree/worktree-lifecycle.service.ts src/backend/services/workspace/service/worktree/worktree-lifecycle.service.test.ts src/backend/server.ts
git commit -m "Invalidate cached Git state (#1943)"
```

### Task 3: Migrate backend consumers

**Files:**
- Modify: `src/backend/trpc/workspace/git.trpc.ts`
- Modify: `src/backend/trpc/workspace/git.router.test.ts`
- Modify: `src/backend/services/git-ops.service.ts`
- Modify: `src/backend/services/workspace/service/query/workspace-query.service.ts`
- Modify: `src/backend/services/workspace/service/query/workspace-query.service.test.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`

**Interfaces:**
- Consumes: `workspaceGitStateService.getSnapshot({ worktreePath, defaultBranch })` and the sectioned snapshot types.
- Produces: existing router results and existing `WorkspaceGitStats` values sourced from one snapshot.

- [ ] **Step 1: Replace direct-Git mocks with failing shared-snapshot delegation tests**

```ts
expect(mockGetSnapshot).toHaveBeenCalledWith({
  worktreePath: '/repo/w1',
  defaultBranch: 'main',
});
expect(await caller.getGitStatus({ workspaceId: 'w1' })).toEqual({
  files: snapshot.status.files,
  hasUncommitted: snapshot.status.hasUncommitted,
});
```

Assert all four aggregate endpoints can run concurrently while `mockGetSnapshot` represents the same service call. Assert reconciliation and sidebar summaries call `getWorkspaceGitStats`, which now delegates to the centralized service, and `hasChanges` uses that same result.

- [ ] **Step 2: Run backend consumer tests and verify RED**

Run: `pnpm vitest run src/backend/trpc/workspace/git.router.test.ts src/backend/services/workspace/service/query/workspace-query.service.test.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts src/backend/services/git-ops.service.test.ts`

Expected: FAIL because the consumers still spawn direct commands or use the old helper.

- [ ] **Step 3: Project each endpoint from the shared snapshot**

Add one helper in the router:

```ts
async function getSnapshotForWorkspace(workspaceId: string) {
  const workspace = await workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  if (!workspace.worktreePath) return null;
  return workspaceGitStateService.getSnapshot({
    worktreePath: workspace.worktreePath,
    defaultBranch: workspace.project?.defaultBranch ?? 'main',
  });
}
```

Throw `Git status failed: ...`, `Git diff failed: ...`, or the upstream diff error only when the requested snapshot section contains that error. Change `gitOpsService.getWorkspaceGitStats` to return `snapshot.base.stats` unless status/base failed. Make `getFileDiff` request the snapshot and reuse `snapshot.base.mergeBase` before its on-demand file command.

- [ ] **Step 4: Run backend tests and verify GREEN**

Run: `pnpm vitest run src/backend/trpc/workspace/git.router.test.ts src/backend/services/workspace/service/query/workspace-query.service.test.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts src/backend/services/git-ops.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit backend migration**

```bash
git add src/backend/trpc/workspace/git.trpc.ts src/backend/trpc/workspace/git.router.test.ts src/backend/services/git-ops.service.ts src/backend/services/workspace/service/query/workspace-query.service.ts src/backend/services/workspace/service/query/workspace-query.service.test.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts
git commit -m "Share Git snapshots across consumers (#1943)"
```

### Task 4: Visibility-aware UI refresh

**Files:**
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.tsx`
- Modify: `src/client/routes/projects/workspaces/workspace-detail-container.utils.ts`
- Modify: `src/components/workspace/combined-changes-panel.tsx`
- Modify: `src/components/workspace/git-summary-panel.tsx`
- Test: `src/components/workspace/combined-changes-panel.test.ts`
- Test: `src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts`

**Interfaces:**
- Consumes: unchanged tRPC endpoint shapes.
- Produces: active panel polling only and archive-dialog on-demand status.

- [ ] **Step 1: Add failing UI option tests**

Keep the existing combined-entry behavior coverage and add a pure visibility predicate test to the container utility suite:

```ts
it('fetches archive Git status only while the dialog is visible for a worktree', () => {
  expect(shouldFetchArchiveGitStatus(false, '/repo/w1')).toBe(false);
  expect(shouldFetchArchiveGitStatus(true, null)).toBe(false);
  expect(shouldFetchArchiveGitStatus(true, '/repo/w1')).toBe(true);
});
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `pnpm vitest run src/components/workspace/combined-changes-panel.test.ts src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts`

Expected: FAIL because the detail container still polls whenever a worktree exists.

- [ ] **Step 3: Make archive status on demand**

```ts
export function shouldFetchArchiveGitStatus(
  archiveDialogOpen: boolean,
  worktreePath: string | null | undefined
): boolean {
  return archiveDialogOpen && Boolean(worktreePath);
}

const { data: gitStatus } = trpc.workspace.getGitStatus.useQuery(
  { workspaceId },
  {
    enabled: shouldFetchArchiveGitStatus(archiveDialogOpen, workspace?.worktreePath),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  }
);
```

Keep the combined changes refresh at 15 seconds because the component is mounted only when both the right panel and Changes tab are visible. Remove the dead `GitSummaryPanel` polling interval or delete the unused component if repository checks confirm it has no imports.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `pnpm vitest run src/components/workspace/combined-changes-panel.test.ts src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit visibility behavior**

```bash
git add src/client/routes/projects/workspaces/workspace-detail-container.tsx src/client/routes/projects/workspaces/workspace-detail-container.utils.ts src/client/routes/projects/workspaces/workspace-detail-container.utils.test.ts src/components/workspace/combined-changes-panel.tsx src/components/workspace/git-summary-panel.tsx src/components/workspace/combined-changes-panel.test.ts
git commit -m "Limit workspace Git polling to visible UI (#1943)"
```

### Task 5: Full verification, review, and PR

**Files:**
- Modify only files required to resolve verification failures.
- Review: all changes from `origin/main`.

**Interfaces:**
- Consumes: the complete implementation.
- Produces: a clean branch and a draft-ready GitHub pull request closing issue #1943.

- [ ] **Step 1: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: every command exits 0. Review and retain intentional formatter changes only.

- [ ] **Step 2: Review the complete diff**

Run: `git diff origin/main` and `git diff --check`.

Check for direct aggregate Git commands outside the centralized service with:

```bash
rg -n "status.*--porcelain|diff.*--numstat|diff.*--name-status|@\{upstream\}" src/backend
```

Expected: aggregate reads live in the centralized service; mutation-time archive status and on-demand file diff are documented exceptions.

- [ ] **Step 3: Run a complexity review and re-verify any changes**

Because the implementation spans more than eight files, use the code-simplifier review requested by the workflow. If review changes code, rerun `pnpm test` and the focused Git-state tests before committing.

- [ ] **Step 4: Commit verification fixes and confirm clean status**

```bash
git add -p
git commit -m "Polish centralized Git state (#1943)"
git status --short
```

Expected: no uncommitted files.

- [ ] **Step 5: Push and create the required PR**

Create `/tmp/pr-body.md` with summary, changes, checked testing items, `Closes #1943`, and the required Factory Factory signature. Then run:

```bash
git push -u origin HEAD
gh pr create --title "Fix #1943: Centralize workspace Git state" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: GitHub returns the newly created PR URL and state.
