---
name: Bug Fix (Orchestrated)
description: Orchestrated bug investigation and fix with systematic verification
expectsPR: true
---

# Orchestrated Bug Fix Workflow

You are the **orchestrator** for fixing a bug. Your role is to systematically investigate, fix, and verify the issue using a disciplined, review-driven approach.

## Core Principles

- **Understand before fixing**: No shotgun debugging
- **Test-driven fixes**: Write failing test, fix bug, verify test passes
- **Minimal changes**: Fix only what's broken
- **Review at every stage**: Verify understanding and implementation
- **Ship with confidence**: Only create PR when regression tests exist

## Workflow Phases

### Phase 1: Investigation & Understanding

**Your Role**: Thoroughly understand the bug before attempting any fix.

1. **Reproduce the Bug**
   - Review bug report symptoms and steps
   - Attempt to reproduce locally if possible
   - Document exact reproduction steps
   - Identify conditions that trigger the bug

2. **Research Context**
   - Use Grep/Glob to find relevant code
   - Read the affected modules completely
   - Understand the intended behavior
   - Check git history for related changes: `git log -p -- <file>`

3. **Form Hypothesis**
   - Trace the code path that leads to the bug
   - Identify the root cause (not just symptoms)
   - Consider: Is this a logic error? Race condition? Edge case? Input validation?
   - Document your hypothesis in TodoWrite

**Decision Point**:
- If root cause is unclear: continue investigation (use Explore agent for deep research)
- If root cause is understood: proceed to plan review

### Phase 2: Investigation Review

**Your Role**: Verify you understand the problem correctly.

**Self-Review Questions**:
- [ ] Can I explain the root cause clearly?
- [ ] Do I understand why the bug occurs?
- [ ] Have I identified the minimal code change needed?
- [ ] Am I fixing the cause, not just the symptom?
- [ ] Have I checked for similar bugs elsewhere?

**Use Task tool with Explore agent** if needed:
- Search for similar patterns in the codebase
- Find all places where the same mistake might exist
- Understand the full impact of the bug

**Decision Point**:
- If understanding is incomplete: continue investigation
- If root cause is clear: proceed to test writing

### Phase 3: Write Failing Test

**Your Role**: Create a test that proves the bug exists.

1. **Design Test Case**
   - Write a test that reproduces the bug
   - Test should fail with current code
   - Test should pass after the fix
   - Keep test focused and minimal

2. **Verify Test Fails**
   ```bash
   pnpm test <test-file>
   ```
   - Confirm the test fails for the right reason
   - Ensure failure output clearly shows the bug

3. **Commit Failing Test**
   ```bash
   git add <test-file>
   git commit -m "Add failing test for <bug description>"
   ```

**Why This Matters**:
- Proves the bug is real
- Ensures the fix actually works
- Prevents regression in the future
- Documents the bug for future developers

### Phase 4: Implement Fix

**Your Role**: Make the minimal change to fix the bug.

1. **Create Fix Plan**
   - Use TodoWrite to outline the fix steps
   - Identify all files that need changes
   - Keep scope minimal (no refactoring)

2. **Implement Changes**
   - Make the smallest change that fixes the bug
   - Follow existing code patterns
   - Add error handling if missing
   - Don't refactor or improve unrelated code

3. **Verify Test Passes**
   ```bash
   pnpm test <test-file>
   ```
   - Confirm the specific test now passes
   - Verify it passes for the right reason

4. **Run Full Test Suite**
   ```bash
   pnpm test
   ```
   - Check for regressions
   - Fix any new failures

5. **Commit Fix**
   ```bash
   git add -A
   git commit -m "Fix <bug description>

   Root cause: [brief explanation]
   Solution: [what changed and why]"
   ```

### Phase 5: Implementation Review

**Your Role**: Critically evaluate your fix.

**Self-Review Checklist**:
- [ ] Does the fix address the root cause?
- [ ] Is this the minimal change needed?
- [ ] Are all edge cases handled?
- [ ] Did I avoid refactoring unrelated code?
- [ ] Do all tests pass? (`pnpm test`)
- [ ] Does it typecheck? (`pnpm typecheck`)
- [ ] Does it follow style? (`pnpm check:fix`)

**Consider**:
- Could this fix break anything else?
- Are there similar bugs elsewhere that need fixing?
- Should we add additional test cases?
- Is error handling appropriate?

**Decision Point**:
- If issues found: fix them now
- If fix is solid: proceed to simplification

### Phase 6: Simplification

**Your Role**: Ensure the fix is clean and maintainable.

Use the **Task tool with code-simplifier agent**:
- Focus on the changed code
- Simplify without changing behavior
- Ensure fix is as clear as possible

**After Simplification**:
- Verify tests still pass: `pnpm test`
- Commit if changes made: `git commit -m "Simplify bug fix"`

### Phase 7: Comprehensive Verification

**Your Role**: Ensure the fix is complete and safe.

1. **Test All Scenarios**
   - Run full test suite: `pnpm test`
   - Test edge cases manually
   - Verify original bug is fixed
   - Check for regressions in related functionality

2. **Static Analysis**
   ```bash
   pnpm typecheck
   pnpm check:fix
   ```

3. **Review Changes**
   ```bash
   git diff origin/main
   ```
   - Is every change necessary?
   - Are commit messages clear?
   - Is the fix easy to understand?

4. **Check for Similar Issues**
   - Search codebase for similar patterns
   - Fix related bugs if found
   - Document any remaining known issues

**Decision Point**:
- If any checks fail: fix and re-verify
- If everything passes: proceed to PR creation

### Phase 8: Pull Request Creation

**Your Role**: Document the fix for reviewers.

1. **Prepare Branch**
   ```bash
   git push -u origin HEAD
   ```

2. **Craft PR Description**
   Focus on helping reviewers understand the bug and fix:

   ```bash
   cat > /tmp/pr-body.md << 'EOF'
   ## Bug Description
   [What was broken and how it manifested]

   ## Root Cause
   [Why the bug occurred - the actual problem in the code]

   ## Reproduction Steps
   1. [Step 1]
   2. [Step 2]
   3. [Observed incorrect behavior]

   ## Fix
   [What changed and why this fixes the root cause]

   ## Testing
   - [X] Added failing test that reproduces the bug
   - [X] Test now passes with fix
   - [X] Full test suite passes (`pnpm test`)
   - [X] No regressions found
   - [X] Type checking passes (`pnpm typecheck`)
   - [X] Linting passes (`pnpm check:fix`)

   ## Related Issues
   [Link any related bugs or issues]

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF

   gh pr create --title "Fix: <concise bug description>" --body-file /tmp/pr-body.md
   ```

3. **Share PR URL**
   - Output the PR URL for user review
   - Confirm CI checks are running

## Guidelines for Orchestration

### When to Use Subagents

✅ **DO** use Task tool for:
- Deep investigation (Explore agent) - complex bug research
- Code simplification (code-simplifier agent) - clean up fix
- Related bug search - find similar issues

❌ **DON'T** use Task tool for:
- Simple code reading - use Read, Grep, Glob directly
- Test writing - implement directly
- Small fixes - implement directly

### Debugging Strategies

**Effective**:
- Read code to understand behavior
- Use git log to understand history
- Write minimal reproduction case
- Test hypothesis with failing test

**Ineffective**:
- Making random changes hoping something works
- Fixing symptoms instead of root cause
- Skipping test writing
- Over-complicating the fix

### Common Bug Patterns

1. **Logic Errors**: Wrong condition, off-by-one, incorrect assumption
2. **Race Conditions**: Timing issues, async bugs, state races
3. **Edge Cases**: Null/undefined, empty arrays, boundary conditions
4. **Type Coercion**: Unexpected type conversions, NaN, falsy values
5. **Scope Issues**: Variable shadowing, closure problems
6. **State Management**: Stale state, improper updates, side effects

### Red Flags

🚩 **Investigation Issues**:
- Making changes without understanding root cause
- Assuming rather than verifying
- Ignoring reproduction steps
- Not checking git history

🚩 **Implementation Issues**:
- Fixing symptoms instead of root cause
- Making changes too broad
- Refactoring unrelated code
- Skipping test creation

🚩 **Verification Issues**:
- Not running full test suite
- Skipping type checking
- Not testing edge cases
- Not checking for regressions

## Success Criteria

A bug fix is ready for PR when:
- ✅ Root cause is clearly understood and documented
- ✅ Failing test exists that reproduces the bug
- ✅ Test now passes with fix
- ✅ All tests pass (`pnpm test`)
- ✅ Types are correct (`pnpm typecheck`)
- ✅ Code follows style (`pnpm check:fix`)
- ✅ Fix is minimal and focused
- ✅ No regressions introduced
- ✅ PR clearly explains bug, cause, and fix

## Anti-Patterns to Avoid

❌ **Shotgun Debugging**: Making random changes hoping one works
❌ **Symptom Fixing**: Hiding the error instead of fixing the cause
❌ **Over-Engineering**: Adding complexity beyond what's needed
❌ **Scope Creep**: Refactoring or improving unrelated code
❌ **Skipping Tests**: Trusting manual testing alone
❌ **Cargo Cult Fixes**: Copying solutions without understanding

Remember: You are the orchestrator. Investigate systematically, fix minimally, verify thoroughly. Every bug fix should leave the codebase better than you found it - not through refactoring, but through preventing the bug from ever happening again.
