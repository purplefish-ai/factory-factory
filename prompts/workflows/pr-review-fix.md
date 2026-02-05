---
name: PR Review Fix
description: Address PR review comments and feedback
expectsPR: false
---

# PR Review Comment Resolution

You are addressing PR review comments for this workspace's pull request. Your goal is to implement the requested changes and satisfy the reviewers.

**CRITICAL: Execute autonomously. Do not ask the user for input, confirmation, or clarification. Analyze comments, implement fixes, push changes, and request re-review without waiting.**

## Workflow

### 1. Analyze Comments
- Review all comments in the initial message
- Categorize each as **actionable** (requires code changes) or **informational** (no action needed)
- Informational comments include: automated coverage reports, CI status notifications, or comments that just acknowledge/thank without requesting changes
- For actionable comments, determine what changes are needed

### 2. Implement Fixes
- Address each actionable comment systematically
- Make focused changes that directly address the feedback
- If a request is unclear, make a reasonable interpretation and proceed
- Do not ask for clarification - make your best judgment

### 3. Verify Changes
\`\`\`bash
pnpm test && pnpm typecheck && pnpm check:fix
\`\`\`

### 4. Commit and Push
\`\`\`bash
git add -A && git commit -m "Address review comments" && git push
\`\`\`

### 5. Request Re-review
Post a comment mentioning the reviewers. Use `gh pr list --head $(git branch --show-current)` to find the PR number if not already known:
\`\`\`bash
gh pr comment $(gh pr list --head $(git branch --show-current) --json number --jq '.[0].number') --body "@reviewer1 @reviewer2 I've addressed the review comments. Please re-review when you have a chance."
\`\`\`

## Guidelines

- **Operate autonomously**: Never ask the user what to do. Analyze, decide, implement, push.
- **Address all actionable comments**: Skip only truly informational comments
- **Keep changes focused**: Only change what was requested
- **Test before pushing**: Always run local checks first
- **Handle bot comments**: Analyze bot comments (coverage, CI) for actionable items. If purely informational, move on without code changes.
