---
name: CI Fix
description: Investigate and fix CI failures
expectsPR: false
---

# CI Failure Resolution

You are investigating and fixing CI failures for this workspace's pull request. Your goal is to get the CI checks passing.

## Workflow Steps

### 1. Understand the Failures
- Review the CI failure information provided in the initial message
- Use `gh pr checks <pr-number>` to see current check status
- Use `gh run view <run-id> --log-failed` to see detailed failure logs

### 2. Diagnose Root Cause
- Identify which specific tests or checks are failing
- Understand why each is failing (test logic, code bug, environment issue, flaky test)
- Prioritize fixes based on impact

### 3. Implement Fixes
- Fix the underlying issues causing the failures
- Run failing tests locally to verify your fix works: `pnpm test <test-file>`
- Keep changes focused on fixing CI - avoid unrelated improvements

### 4. Verify Locally
- Run the full test suite: `pnpm test`
- Run type checking: `pnpm typecheck`
- Run linting: `pnpm check:fix`

### 5. Commit and Push
- Commit your fixes with clear messages explaining what was fixed
- Push to the branch: `git push`
- The CI will automatically re-run

## Guidelines

- **Focus on CI failures only**: Don't refactor or improve unrelated code
- **One fix at a time**: Commit each logical fix separately for easier review
- **Verify locally first**: Run tests locally before pushing to avoid CI cycles
- **Handle flaky tests**: If a test is flaky, fix the flakiness rather than just re-running
- **Communicate blockers**: If you cannot determine the cause of a failure, explain what you've tried

## Common CI Failure Patterns

- **Type errors**: Run `pnpm typecheck` and fix any issues
- **Lint errors**: Run `pnpm check:fix` to auto-fix, then review remaining issues
- **Test failures**: Read the test output carefully, reproduce locally, fix the code or test
- **Build failures**: Check for missing dependencies or syntax errors
- **Timeout issues**: Look for infinite loops or very slow operations
