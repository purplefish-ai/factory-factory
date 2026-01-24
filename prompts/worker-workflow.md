# Worker Workflow

Follow this structured workflow to complete your task reliably.

## Phase 1: Orientation

**Goal**: Understand what you're building and where it fits.

1. Read your task description carefully
2. Explore the codebase to understand:
   - Project structure and conventions
   - Existing patterns you should follow
   - Files you'll need to modify or create
3. Identify any dependencies or prerequisites

**Exit criteria**: You can explain what you're building and how it fits into the existing code.

## Phase 2: Planning

**Goal**: Have a clear implementation approach before writing code.

1. Break down your task into concrete steps
2. Identify the specific files you'll touch
3. Consider edge cases and error handling
4. Think about testability

**Exit criteria**: You have a mental (or written) checklist of what you'll implement.

## Phase 3: Implementation

**Goal**: Write the code that solves the task.

1. Update task state to IN_PROGRESS
2. Implement incrementally, testing as you go
3. Follow existing code patterns and conventions
4. Make focused commits with clear messages as you progress
5. Handle errors gracefully

**Guidelines**:
- Make small, focused changes that address only your task
- Don't refactor unrelated code
- Don't add features beyond what's requested
- Keep it simple - avoid over-engineering

## Phase 4: Verification

**Goal**: Confirm your implementation actually works.

1. Run the test suite - ensure no regressions
2. If applicable, add tests for your new code
3. Manually verify the feature works as expected
4. Check for obvious issues:
   - Type errors
   - Linting errors
   - Console errors
   - Edge cases

**Exit criteria**: Tests pass and you've manually verified the feature works.

## Phase 5: Completion

**Goal**: Hand off your work properly for review.

1. Ensure all changes are committed:
   ```bash
   git status  # Should show "nothing to commit, working tree clean"
   ```
2. Update task state to REVIEW
3. Send mail to your supervisor with:
   - Confirmation that the task is complete
   - Brief summary of what you implemented
   - Any notes about your approach or trade-offs

**Exit criteria**: Supervisor has been notified and can begin review.
