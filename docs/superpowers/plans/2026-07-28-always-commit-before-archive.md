# Always Commit Before Workspace Archive Implementation Plan

**Goal:** Make archive always preserve uncommitted work, keep confirmation available without a Git
status preflight, and turn Git index-lock failures into an explicit remove-and-retry recovery flow.

**Architecture:** The backend owns the safety invariant. Archive APIs remove the commit choice and
accept only an optional one-shot `removeGitIndexLock` recovery action. Git operations classify an
exact worktree index lock with a machine-readable application-error kind propagated through tRPC.
Workspace detail and Kanban restore optimistic state on failure and show a shared recovery dialog.

**Tech stack:** TypeScript, Express/tRPC, React, React Query, Vitest, jsdom

## Constraints

- Never delete an index lock automatically.
- Never accept a filesystem path from the client.
- Resolve and remove only the current worktree's server-derived `index.lock`.
- Preserve archive rollback and cache-restoration behavior for every failure.
- Startup recovery must not remove locks because no user is present to approve it.
- Keep unrelated Git failures as ordinary archive errors.

## Task 1: Backend always-commit and lock classification

**Files:**

- Modify `src/backend/lib/application-error.ts`
- Modify `src/backend/trpc/trpc.ts`
- Modify `src/backend/services/workspace/service/worktree/git-ops.service.ts`
- Modify colocated tests

1. Add failing tests for an optional application-error kind and tRPC
   `applicationErrorKind` data.
2. Add failing Git service tests proving:
   - dirty worktrees always stage and commit;
   - a failed add with the exact lock present returns `GIT_INDEX_LOCKED`;
   - unrelated add failures remain internal errors;
   - explicit recovery removes only the derived lock before staging;
   - missing locks are harmless and removal failures stop archive.
3. Run the focused tests and confirm the expected failures.
4. Add the application-error metadata and safe lock-resolution implementation.
5. Re-run the focused tests to green.

## Task 2: Archive orchestration and API contracts

**Files:**

- Modify `src/backend/services/workspace/service/worktree/worktree-lifecycle.service.ts`
- Modify `src/backend/orchestration/workspace-archive.orchestrator.ts`
- Modify `src/backend/trpc/workspace.trpc.ts`
- Modify `src/backend/trpc/workspace/children.trpc.ts`
- Modify `src/backend/services/session/service/acp/child-workspace-mcp-server.ts`
- Modify related tests and test utilities

1. Add failing tests for option-free normal archive, explicit lock recovery, bulk error
   discrimination, and startup recovery without lock removal.
2. Remove `commitUncommitted` from schemas and callers.
3. Thread `removeGitIndexLock` only through explicit single/child recovery calls.
4. Return `applicationErrorKind` for per-workspace bulk failures.
5. Allow the child-workspace tool to request lock removal only via an explicit optional flag whose
   description requires user confirmation.
6. Run router, orchestration, lifecycle, and child-tool tests to green.

## Task 3: Confirmation and recovery dialogs

**Files:**

- Modify `src/client/features/workspace/archive-workspace-dialog.tsx`
- Modify `src/client/features/workspace/archive-workspace-dialog.test.tsx`
- Create `src/client/features/workspace/archive-git-lock-dialog.tsx`
- Create `src/client/features/workspace/archive-git-lock-dialog.test.tsx`
- Modify `src/client/features/workspace/index.ts`

1. Replace the existing loading/checkbox test with a failing regression proving archive is enabled
   and confirms with no Boolean argument.
2. Add failing recovery-dialog tests for Cancel, Retry, and Remove Lock and Archive.
3. Simplify archive confirmation copy and props.
4. Implement and export the shared recovery dialog.
5. Run both dialog test files to green.

## Task 4: Workspace-detail integration

**Files:**

- Modify `src/client/routes/projects/workspaces/workspace-detail-container.tsx`
- Modify `src/client/routes/projects/workspaces/workspace-detail-view.tsx`
- Modify `src/client/routes/projects/workspaces/use-workspace-detail.ts`
- Modify related utility and view tests

1. Add failing coverage for option-free archive input and recognition of
   `GIT_INDEX_LOCKED`.
2. Remove the archive-only Git-status query and loading/dirty dialog props.
3. Open the recovery dialog after rollback instead of showing a generic toast for a lock conflict.
4. Retry normally or with the one-shot lock-removal action.
5. Run workspace-detail tests to green.

## Task 5: Kanban single and bulk recovery

**Files:**

- Modify `src/client/features/kanban/kanban-context.tsx`
- Modify `src/client/features/kanban/kanban-context.test.tsx`
- Modify `src/client/features/kanban/kanban-board.tsx`
- Modify `src/client/features/kanban/kanban-card.tsx`
- Modify `src/client/features/kanban/kanban-column.tsx`
- Modify related Kanban tests

1. Add failing provider tests proving single and bulk lock failures restore cached workspaces and
   expose only locked IDs for recovery.
2. Add failing tests proving recovery retries only those IDs and sends
   `removeGitIndexLock: true` only for the explicit destructive action.
3. Remove commit-choice callback parameters and bulk checkbox UI.
4. Render the shared recovery dialog from the board.
5. Preserve generic toasts for non-lock failures.
6. Run focused Kanban tests to green.

## Task 6: Verification

1. Format scoped files with Biome.
2. Run all focused backend and client tests touched by the change.
3. Run `pnpm typecheck`.
4. Run `pnpm check`.
5. Run `pnpm test`.
6. Review `git diff`, `git diff --check`, and `git status` for unrelated changes.
