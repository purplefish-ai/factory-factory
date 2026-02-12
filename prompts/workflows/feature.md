---
name: Feature
description: End-to-end feature implementation with PR creation
expectsPR: true
---

# Feature Implementation Workflow

You are implementing a new feature. Follow this workflow to deliver high-quality, production-ready code.

## Workflow Steps

### 1. Understand Requirements
- Read any linked issues, PRs, or documentation
- Clarify ambiguous requirements before starting implementation
- Identify affected areas of the codebase

### 2. Plan the Implementation
- Use the TodoWrite tool to create a task list
- Break down the work into logical commits
- Consider edge cases and error handling upfront

### 3. Implement the Feature
- Write clean, well-structured code
- Follow existing patterns in the codebase
- Add appropriate type definitions
- Keep commits focused and atomic

### 4. Test Your Changes
- Run the existing test suite (`pnpm test`)
- Add new tests for your feature
- Test edge cases and error scenarios
- Verify the feature works end-to-end

### 5. Verify Build and Lint
- Run `pnpm typecheck` to catch type errors
- Run `pnpm check:fix` to fix linting issues
- Ensure the build passes (`pnpm build:all`)

### 6. Capture UI Screenshots (if applicable)

If your changes affect the UI:

1. Read `factory-factory.json` for the `scripts.run` command, pick a free port, replace `{port}`, and start it in the background.
2. Use `browser_navigate` to visit the dev server URL
3. Determine the most relevant screen showing your changes and capture a screenshot
4. Save screenshots to `.factory-factory/screenshots/` with descriptive names
5. Commit the screenshots
6. Reference them in the PR body using raw GitHub URLs:
   `![Description](https://raw.githubusercontent.com/{owner}/{repo}/{branch}/.factory-factory/screenshots/filename.png)`

### 7. Create Pull Request
- Commit all changes with descriptive messages
- Push your branch: `git push -u origin HEAD`
- Create the PR using the GitHub CLI with a body file to preserve formatting:
  ```bash
  cat > /tmp/pr-body.md << 'EOF'
  ## Summary
  [Clear description of what this PR accomplishes]

  ## Changes
  - [List of key changes]

  ## Testing
  - [How to test the changes]
  EOF
  gh pr create --title "Your PR title" --body-file /tmp/pr-body.md
  ```
- **IMPORTANT**: Always append the following signature as the very last lines of the PR body, after a horizontal rule:
  ```
  ---
  🏭 Forged in [Factory Factory](https://factoryfactory.ai)
  ```

## Guidelines

- **Protect context**: For complex sub-tasks, use the Task tool to spawn specialized agents
- **Commit early, commit often**: Make atomic commits as you complete each logical unit
- **Test-driven when appropriate**: Write tests before or alongside implementation
- **Ask questions**: If requirements are unclear, ask before making assumptions
