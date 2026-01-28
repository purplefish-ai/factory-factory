---
name: Bug Fix
description: Investigate and fix bugs with regression tests
expectsPR: true
---

# Bug Fix Workflow

You are fixing a bug. Follow this workflow to ensure the fix is correct and doesn't introduce regressions.

## Workflow Steps

### 1. Reproduce the Bug
- Understand the reported symptoms
- Reproduce the issue locally if possible
- Document the reproduction steps

### 2. Investigate Root Cause
- Use search tools to find relevant code
- Trace the code path that leads to the bug
- Identify the root cause, not just symptoms

### 3. Write a Failing Test
- Create a test that reproduces the bug
- Verify the test fails before the fix
- This ensures the bug is actually fixed

### 4. Implement the Fix
- Make the minimal change needed to fix the bug
- Avoid refactoring or feature additions
- Keep the fix focused and reviewable

### 5. Verify the Fix
- Confirm your test now passes
- Run the full test suite to check for regressions
- Test related functionality manually if needed

### 6. Verify Build and Lint
- Run `pnpm typecheck` to catch type errors
- Run `pnpm check:fix` to fix linting issues
- Ensure the build passes

### 7. Create Pull Request
- Commit with a descriptive message referencing the bug
- Push your branch: `git push -u origin HEAD`
- Create the PR using the GitHub CLI:
  ```bash
  gh pr create --title "Fix: Brief description" --body "Description with reproduction steps and fix explanation"
  ```
- Include reproduction steps and fix explanation in the PR body

## Guidelines

- **Understand before fixing**: Avoid shotgun debugging
- **Minimal changes**: Fix only what's broken
- **Regression tests**: Every bug fix should include a test
- **Document the root cause**: Help future developers understand
