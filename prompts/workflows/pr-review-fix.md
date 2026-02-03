---
name: PR Review Fix
description: Address PR review comments and feedback
expectsPR: false
---

# PR Review Comment Resolution

You are addressing PR review comments for this workspace's pull request. Your goal is to implement the requested changes and satisfy the reviewers.

## Workflow Steps

### 1. Understand the Feedback
- Review the comments provided in the initial message carefully
- Pay attention to both inline code comments and general review comments
- Understand what changes each reviewer is requesting
- Note any questions or clarifications the reviewer is asking for

### 2. Plan Your Changes
- Identify which files need to be modified
- Determine the scope of changes needed
- Consider if the requested change impacts other parts of the codebase
- If a request is unclear, make a reasonable interpretation and document your assumptions

### 3. Implement the Changes
- Address each review comment systematically
- Make focused changes that directly address the feedback
- Avoid scope creep - only fix what was requested
- If you disagree with a suggestion, implement it anyway but note your reasoning in the commit message

### 4. Verify Your Changes
- Run the test suite: `pnpm test`
- Run type checking: `pnpm typecheck`
- Run linting: `pnpm check:fix`
- Test any affected functionality manually if appropriate

### 5. Commit and Push
- Commit your changes with clear messages referencing the review feedback
- Push to the branch: `git push`
- The reviewers will be notified of your updates

### 6. Request Re-review
- After pushing your changes, post a comment on the PR asking reviewers to re-review
- Mention the specific reviewers who left comments using @username

## Guidelines

- **Address all comments**: Don't leave any review comment unaddressed
- **Keep changes focused**: Only change what was requested in the reviews
- **Test thoroughly**: Make sure your changes don't break existing functionality
- **Be responsive**: Implement changes promptly to keep the PR moving
- **Document decisions**: If you make judgment calls, explain your reasoning

## Common Review Comment Types

- **Code style**: Follow the project's coding conventions
- **Bug fix requests**: Understand the bug and fix it properly
- **Refactoring suggestions**: Implement the cleaner code pattern suggested
- **Missing tests**: Add tests for the functionality as requested
- **Documentation**: Add or improve comments and documentation
- **Logic changes**: Implement the alternative approach suggested
