# Auto-Iteration Runtime Cleanup Design

## Goal

Preserve Factory Factory's untracked runtime artifacts when auto-iteration discards an
implementing-phase timeout's uncommitted work.

## Root Cause

`AutoIterationService` handles an implementing-phase prompt timeout by calling
`discardUncommittedChanges`. That helper hard-resets tracked content and then runs
`git clean -fd`, which deletes every untracked file and directory. The auto-iteration
logbook lives under the intentionally untracked `.factory-factory/` directory, so the
cleanup deletes it before the timeout recovery path appends its crash entry. The append
then throws, preventing the updated crash count and iteration timestamp from being
persisted.

## Design

Before the hard reset, reset the index entry for `/.factory-factory/` to `HEAD`. If
`HEAD` does not exist yet, recursively remove the runtime directory from the index with
forced cached-only removal, which also handles partially staged runtime files without
changing their working-tree contents. A repository with a commit keeps the existing
hard reset. On an unborn branch, clear the rest of the index with the same cached-only
operation because there is no commit to restore. Then pass the root-anchored exclusion
`-e /.factory-factory/` to `git clean`. This protects the complete root runtime directory
while continuing to remove ordinary untracked implementation work, including nested
directories that happen to share its name.

The exclusion belongs in `discardUncommittedChanges`, where the destructive cleanup is
defined, rather than in the timeout caller. This keeps every caller of the helper on the
same safety boundary and avoids coupling generic Git cleanup to individual logbook
files. No `.gitignore` change is needed because commit exclusion and cleanup protection
are separate concerns.

## Alternatives Considered

1. Unstage `/.factory-factory/`, then exclude the anchored root directory from `git clean`.
   Selected because all untracked and newly staged files under this application-owned
   runtime directory must survive cleanup without protecting same-named directories
   elsewhere.
2. Exclude only `.factory-factory/auto-iteration-logbook.json`. Rejected because insights,
   strategy, screenshots, and future runtime artifacts would remain vulnerable.
3. Add `.factory-factory/` to the repository `.gitignore`. Rejected because the worktree
   belongs to the user's project and the current unstage behavior intentionally keeps
   runtime artifacts out of commits without modifying project ignore policy.

## Edge Cases

- Modified tracked files are still restored to `HEAD`.
- Ordinary untracked files and directories are still deleted.
- Every untracked or newly staged file below the root `.factory-factory/` survives,
  including nested files.
- Same-named directories below other repository paths remain ordinary untracked work and
  are deleted.
- Runtime paths already tracked by `HEAD` retain normal hard-reset behavior.
- Before the initial commit, staged and partially staged non-runtime files are cleared
  from the index and deleted while the latest root runtime contents survive.
- Workspace Git state is invalidated after both successful and failed cleanup, preserving
  current cache behavior.
- Progress-persistence hardening when logbook writes fail is outside this issue's focused
  scope.

## Testing

Add real-Git regression tests that create a temporary repository with committed tracked
content, modify that content, create ordinary untracked files, stage nested runtime files
under the root `.factory-factory/`, and create an untracked `src/.factory-factory/` file.
Also exercise an unborn branch containing staged-then-edited runtime and non-runtime
files. After `discardUncommittedChanges`, assert that committed tracked content is
restored when available, ordinary and same-named nested untracked content is removed,
and the latest root runtime content is unchanged.

Run the focused regression file before and after the implementation, followed by the
required typecheck, formatter, full test suite, and production build.

## Scope

This is a backend-only Git cleanup change. It requires no UI changes, screenshots,
database migration, schema update, or API change.
