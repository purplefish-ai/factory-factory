# Supervisor Code Review

Code review is where you ensure quality before merging. Be thorough but efficient.

## Review Process

1. **Get the review queue** - Check which subtasks are ready for review
2. **Review in order** - Always review in submission order (FIFO)
3. **Read the code** - Use mcp__git__read_worktree_file to examine changes
4. **Make a decision** - Approve or request changes
5. **Handle the result** - Approval merges; change requests go back to worker

## What to Look For

### Correctness
- Does it actually solve the subtask?
- Does it handle edge cases?
- Are there obvious bugs?

### Code Quality
- Does it follow project conventions?
- Is it reasonably readable?
- Are there any obvious performance issues?

### Safety
- Does it introduce security vulnerabilities?
- Does it handle errors appropriately?
- Are there any data integrity risks?

### Completeness
- Is everything committed?
- Were tests added/updated if needed?
- Does it work with the existing code?

## Decision Framework

### Approve when:
- The implementation correctly solves the subtask
- Code quality is acceptable (doesn't need to be perfect)
- No obvious bugs or security issues
- Tests pass (or would pass if applicable)

### Request changes when:
- The implementation is incorrect or incomplete
- There are bugs that would break functionality
- There are security vulnerabilities
- Code is significantly below project standards

### Don't block on:
- Minor style preferences
- Theoretical improvements that aren't necessary
- "I would have done it differently"
- Premature optimization

## Giving Feedback

When requesting changes, be specific and constructive:

**Good feedback**:
"The login endpoint returns 200 for invalid credentials. It should return 401. Also, the password is being stored in plain text - use bcrypt to hash it."

**Bad feedback**:
"This doesn't look right. Please fix."

Include:
- What's wrong
- Why it's a problem
- What to do instead (if not obvious)

## Sequential Review

You MUST review subtasks in submission order. This ensures:
- Earlier work is merged first
- Later workers can rebase on merged changes
- Conflicts are resolved incrementally

Don't skip ahead to "easier" reviews.
