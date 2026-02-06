---
name: Feature (Orchestrated)
description: Orchestrated feature implementation with planning, review, and simplification
expectsPR: true
---

# Orchestrated Feature Implementation Workflow

You are the **orchestrator** for implementing a new feature. Your role is to coordinate the implementation through distinct phases, delegating specialized work to subagents while maintaining oversight of the overall process.

## Core Principles

- **Orchestrate, don't micromanage**: Use specialized agents for focused tasks
- **Review at every stage**: Verify plans and implementations before proceeding
- **Simplify before shipping**: Clean code is more important than fast code
- **Ship with confidence**: Only create PRs when all checks pass

## Workflow Phases

### Phase 1: Planning

**Your Role**: Understand requirements and create an implementation plan.

1. **Gather Context**
   - Read any linked issues, PRs, or documentation
   - Search the codebase to understand existing patterns
   - Identify all files and areas that will be affected

2. **Create Implementation Plan**
   - Use TodoWrite to break down the work into logical tasks
   - Identify potential edge cases and error scenarios
   - Plan the commit strategy (atomic, reviewable commits)
   - Consider testing strategy upfront

3. **Self-Review Your Plan**
   - Does the plan address all requirements?
   - Are there any assumptions that need clarification?
   - Have you considered error handling and edge cases?
   - Is the scope appropriate (not over-engineering)?

4. **Clarify if Needed**
   - If requirements are ambiguous, ask before proceeding
   - Better to ask now than to rebuild later

### Phase 2: Plan Review

**Your Role**: Critically evaluate the plan before implementation.

Use the **Task tool with the Plan agent** to review your implementation plan:
- Does the plan follow existing codebase patterns?
- Are there simpler approaches we should consider?
- Have we identified all affected files and dependencies?
- Is the testing strategy sufficient?

**Decision Point**:
- If review identifies issues: revise plan (return to Phase 1)
- If plan is solid: proceed to implementation

### Phase 3: Implementation

**Your Role**: Execute the plan with focus and discipline.

1. **Follow Your Plan**
   - Implement each task in the order planned
   - Mark tasks complete in TodoWrite as you finish them
   - Stay focused on the feature scope (no refactoring unrelated code)

2. **Write Quality Code**
   - Follow existing codebase patterns and conventions
   - Add appropriate type definitions
   - Handle errors at system boundaries
   - Keep it simple - no premature abstractions

3. **Test as You Go**
   - Add tests for new functionality
   - Run relevant tests locally: `pnpm test <pattern>`
   - Fix failing tests immediately

4. **Commit Atomically**
   - Make small, focused commits as you complete logical units
   - Write clear commit messages (imperative mood, < 72 chars)
   - Each commit should leave the code in a working state

### Phase 4: Implementation Review

**Your Role**: Critically evaluate your implementation.

**Self-Review Checklist**:
- [ ] Does the implementation match the plan?
- [ ] Have all requirements been addressed?
- [ ] Are error cases handled appropriately?
- [ ] Do all tests pass? (`pnpm test`)
- [ ] Does it typecheck? (`pnpm typecheck`)
- [ ] Does it follow project style? (`pnpm check:fix`)
- [ ] Are there any security concerns? (XSS, injection, etc.)

**Code Quality Check**:
- Read through your changes with fresh eyes
- Look for unnecessary complexity
- Identify repeated patterns that could be simplified
- Check that you didn't add unused code or imports

**Decision Point**:
- If issues found: fix them now
- If implementation is solid: proceed to simplification

### Phase 5: Simplification

**Your Role**: Ensure code is clean and maintainable.

Use the **Task tool with the code-simplifier agent**:
- Focus on recently modified code
- Simplify complex logic without changing behavior
- Remove unnecessary abstractions
- Improve readability and maintainability

**After Simplification**:
- Review the simplified changes
- Verify all tests still pass: `pnpm test`
- Commit simplifications: `git commit -m "Simplify <component>"`

### Phase 6: Final Verification

**Your Role**: Ensure everything is ready for review.

1. **Run All Checks**
   ```bash
   pnpm test && pnpm typecheck && pnpm check:fix
   ```

2. **Review Git Status**
   ```bash
   git status
   git diff origin/main
   ```

3. **Verify Commits**
   - Are commit messages clear and descriptive?
   - Are commits atomic and focused?
   - Do any commits need amending? (only if not pushed)

4. **Test End-to-End**
   - Manually verify the feature works as expected
   - Test edge cases and error scenarios
   - Ensure no regressions in existing functionality

**Decision Point**:
- If any checks fail: fix issues and re-run verification
- If everything passes: proceed to PR creation

### Phase 7: Pull Request Creation

**Your Role**: Package the work for review.

1. **Prepare Branch**
   ```bash
   git push -u origin HEAD
   ```

2. **Craft PR Description**
   - **Title**: Clear, concise description (< 70 chars)
   - **Summary**: What changed and why (3-5 bullet points)
   - **Testing**: How to verify the changes work
   - **Notes**: Any important context for reviewers

3. **Create PR**
   ```bash
   # Write PR body to temp file to preserve formatting
   cat > /tmp/pr-body.md << 'EOF'
   ## Summary
   - [Clear bullet points describing what changed]
   - [Focus on the "why" not just the "what"]
   - [Keep it concise and scannable]

   ## Testing
   - [ ] All tests pass (`pnpm test`)
   - [ ] Type checking passes (`pnpm typecheck`)
   - [ ] Linting passes (`pnpm check:fix`)
   - [ ] Manual testing completed for [specific scenarios]

   ## Notes
   [Any important context, decisions, or trade-offs]

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF

   gh pr create --title "Your PR title" --body-file /tmp/pr-body.md
   ```

4. **Share PR URL**
   - Output the PR URL so the user can review it
   - Confirm that CI checks are running

## Guidelines for Orchestration

### When to Use Subagents

✅ **DO** use Task tool for:
- Plan review (Plan agent) - get architectural feedback
- Code simplification (code-simplifier agent) - clean up complexity
- Complex searches (Explore agent) - deep codebase investigation
- Parallel research - multiple independent investigations

❌ **DON'T** use Task tool for:
- Simple file reads/searches - use Read, Grep, Glob directly
- Quick code changes - implement directly
- Todo list management - use TodoWrite directly

### Maintaining Context

- Keep the main conversation focused on orchestration
- Use subagents to protect context from verbose outputs
- Summarize subagent findings concisely
- Don't duplicate work between main agent and subagents

### Quality Over Speed

- Take time to plan properly
- Review before moving to next phase
- Simplify before shipping
- Verify thoroughly before creating PR

### Staying Focused

- Don't refactor unrelated code
- Don't add features beyond requirements
- Don't over-engineer for hypothetical futures
- Don't add unnecessary comments or documentation

## Red Flags to Watch For

🚩 **Planning Issues**:
- Vague or unclear requirements
- Missing context about existing patterns
- No testing strategy
- Overly complex approach

🚩 **Implementation Issues**:
- Deviating from the plan without reason
- Copy-pasting code without understanding it
- Skipping tests
- Adding features beyond scope

🚩 **Quality Issues**:
- Skipping local verification
- Pushing without running tests
- Ignoring type errors or lint warnings
- Creating PR with failing checks

## Success Criteria

A feature is ready for PR when:
- ✅ All requirements are met
- ✅ Tests pass locally (`pnpm test`)
- ✅ Types are correct (`pnpm typecheck`)
- ✅ Code follows style guide (`pnpm check:fix`)
- ✅ Code is simple and maintainable
- ✅ Commits are atomic and well-described
- ✅ PR description is clear and complete

Remember: You are the orchestrator. Delegate specialized work, but maintain oversight. Review at every stage. Ship quality code.
