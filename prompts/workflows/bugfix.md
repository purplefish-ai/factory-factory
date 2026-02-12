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

### 7. Capture UI Screenshots (if applicable)

If your changes affect the UI:

1. Read `factory-factory.json` for the `scripts.run` command, pick a free port, replace `{port}`, and start it in the background.
2. Use `browser_navigate` to visit the dev server URL
3. Determine the most relevant screen showing your changes and capture a screenshot
4. Save screenshots to `.factory-factory/screenshots/` with descriptive names
5. Commit the screenshots
6. Reference them in the PR body using raw GitHub URLs:
   `![Description](https://raw.githubusercontent.com/{owner}/{repo}/{branch}/.factory-factory/screenshots/filename.png)`

### 8. Create Pull Request
- Commit with a descriptive message referencing the bug
- Push your branch: `git push -u origin HEAD`
- Create the PR using the GitHub CLI with a body file to preserve formatting:
  ```bash
  cat > /tmp/pr-body.md << 'EOF'
  ## Bug Fix
  [Description of the bug and how it was fixed]

  ## Reproduction Steps
  1. [Steps to reproduce the original bug]

  ## Fix Explanation
  [Technical explanation of the fix]

  ## Testing
  - [How to verify the fix works]
  EOF
  gh pr create --title "Fix: Brief description" --body-file /tmp/pr-body.md
  ```
- **IMPORTANT**: Always append the following signature as the very last lines of the PR body, after a horizontal rule:
  ```
  ---
  🏭 Forged in [Factory Factory](https://factoryfactory.ai)
  ```

## Guidelines

- **Understand before fixing**: Avoid shotgun debugging
- **Minimal changes**: Fix only what's broken
- **Regression tests**: Every bug fix should include a test
- **Document the root cause**: Help future developers understand
