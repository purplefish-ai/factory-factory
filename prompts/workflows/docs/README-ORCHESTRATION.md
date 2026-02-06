# Orchestrated Workflow Guide

## Overview

The orchestrated workflows represent an improved approach to agent-driven development that emphasizes:

1. **Planning before implementation**
2. **Self-review at every stage**
3. **Systematic verification**
4. **Code simplification before shipping**
5. **Subagent orchestration for complex tasks**

## Available Orchestrated Workflows

### Feature (Orchestrated)
**File**: `feature-orchestrated.md`

**When to Use**: Implementing new features from scratch

**Key Phases**:
1. Planning - Understand requirements and create implementation plan
2. Plan Review - Validate plan before coding
3. Implementation - Execute the plan
4. Implementation Review - Verify implementation quality
5. Simplification - Clean up code using code-simplifier agent
6. Final Verification - Run all checks
7. PR Creation - Ship with confidence

### Bug Fix (Orchestrated)
**File**: `bugfix-orchestrated.md`

**When to Use**: Fixing bugs with regression tests

**Key Phases**:
1. Investigation & Understanding - Find root cause
2. Investigation Review - Verify understanding
3. Write Failing Test - Prove bug exists
4. Implement Fix - Minimal change to fix
5. Implementation Review - Verify fix quality
6. Simplification - Clean up if needed
7. Comprehensive Verification - Ensure no regressions
8. PR Creation - Document bug and fix

### Ratchet (Orchestrated)
**File**: `ratchet-orchestrated.md`

**When to Use**: Autonomous PR progression (CI fixes, review comments)

**Key Phases**:
0. Branch Synchronization - ALWAYS merge main first
1. Issue Analysis - Understand what needs fixing
2. Implementation - Make focused fixes
3. Implementation Review - Verify fix quality
4. Local Verification - Run all checks
5. Simplification - Clean up if needed
6. Commit and Push - Ship the fix
7. Post-Push Actions - Request re-review if needed

## Core Design Principles

### 1. Orchestration Over Micromanagement

**Old Approach**:
```
Agent does everything in one long session:
- Searches for files
- Reads lots of code
- Makes changes
- Tests
- Creates PR
```

**New Approach**:
```
Main agent orchestrates, delegating specialized work:
- Main agent: Plans and coordinates
- Plan agent: Reviews approach
- Explore agent: Deep codebase research
- Code-simplifier agent: Cleans up complexity
- Main agent: Creates PR
```

**Benefits**:
- Main context stays clean and focused
- Specialized agents handle complex sub-tasks
- Better separation of concerns
- More efficient use of context window

### 2. Review at Every Stage

Each workflow has built-in review checkpoints:

**Planning → Plan Review → Implementation → Implementation Review → Simplification → Final Verification → PR**

This catches issues early when they're cheap to fix.

### 3. Simplification Before Shipping

Every workflow includes a simplification phase using the code-simplifier agent:
- Reduces complexity
- Improves readability
- Maintains behavior
- Makes code more maintainable

### 4. Test-Driven Bug Fixes

Bug fixes follow TDD principles:
1. Write failing test (proves bug exists)
2. Implement fix
3. Verify test passes
4. Run full suite (check regressions)

This ensures bugs stay fixed and provides documentation.

### 5. Autonomous Operation (Ratchet)

Ratchet workflow operates completely autonomously:
- No user input required
- Makes reasonable decisions
- Progresses PRs toward merge
- Handles CI and review comments

## When to Use Subagents

### ✅ DO Use Subagents For:

**Plan Agent**:
- Reviewing implementation approach
- Getting architectural feedback
- Validating complex plans

**Explore Agent**:
- Deep codebase investigation
- Finding similar patterns
- Understanding complex systems
- Researching multiple files

**Code-Simplifier Agent**:
- Cleaning up after implementation
- Reducing complexity
- Improving readability
- Maintaining behavior while simplifying

### ❌ DON'T Use Subagents For:

- Simple file reads (`Read` tool is faster)
- Quick searches (`Grep`/`Glob` tools are faster)
- Todo list management (`TodoWrite` tool)
- Small code changes (implement directly)
- Single file modifications

## Migration Guide

### Updating Workflow References

The orchestrated workflows are designed to coexist with existing workflows. To migrate:

1. **Test with New Workflows**:
   - Try `feature-orchestrated` on new features
   - Try `bugfix-orchestrated` on bug fixes
   - Try `ratchet-orchestrated` on ratchet sessions

2. **Compare Results**:
   - Code quality
   - PR clarity
   - Development speed
   - Context efficiency

3. **Full Migration** (if satisfied):
   - Replace `feature.md` with `feature-orchestrated.md`
   - Replace `bugfix.md` with `bugfix-orchestrated.md`
   - Replace `ratchet.md` with `ratchet-orchestrated.md`

### Code Changes Required

Update workflow references in code:

**In `src/backend/prompts/workflows.ts`**:
- No changes needed - system loads all `.md` files
- Workflows are referenced by filename without extension

**In services that reference workflows**:
```typescript
// Old
const workflow = 'feature';

// New (for testing)
const workflow = 'feature-orchestrated';

// After migration (rename files)
const workflow = 'feature'; // points to orchestrated version
```

**In database/tests**:
```typescript
// Update any hardcoded workflow references
workflow: 'feature-orchestrated'
```

### Gradual Adoption Strategy

**Phase 1: Parallel Testing**
- Keep existing workflows
- Add orchestrated workflows with `-orchestrated` suffix
- Let users choose which to use

**Phase 2: Default to Orchestrated**
- Update constants to use orchestrated workflows:
  ```typescript
  export const DEFAULT_FIRST_SESSION = 'feature-orchestrated';
  export const DEFAULT_FOLLOWUP = 'followup';
  ```

**Phase 3: Full Migration**
- Rename orchestrated files (remove `-orchestrated` suffix)
- Archive old workflows
- Update all references

## Workflow Comparison

### Feature Workflow

| Aspect | Old | New (Orchestrated) |
|--------|-----|-------------------|
| Planning | Implicit | Explicit phase with TodoWrite |
| Review | None | Plan review + implementation review |
| Simplification | None | Dedicated phase with agent |
| Verification | Basic | Comprehensive multi-step |
| Subagents | Rare | Strategic use for complexity |
| Structure | Linear checklist | Phased with decision points |

### Bug Fix Workflow

| Aspect | Old | New (Orchestrated) |
|--------|-----|-------------------|
| Investigation | Basic | Systematic with hypothesis |
| Testing | After fix | Before fix (TDD) |
| Review | None | Investigation + implementation review |
| Simplification | None | Dedicated phase |
| Documentation | Basic | Detailed root cause analysis |
| Verification | Basic | Comprehensive regression testing |

### Ratchet Workflow

| Aspect | Old | New (Orchestrated) |
|--------|-----|-------------------|
| Sync | Mentioned | Mandatory Phase 0 |
| Planning | None | TodoWrite for complex fixes |
| Review | None | Implementation review before push |
| Simplification | None | Conditional phase |
| Verification | Basic | Systematic multi-check |
| Autonomy | Emphasized | Enforced with decision trees |

## Best Practices

### 1. Trust the Process

Each phase exists for a reason. Don't skip phases even when tempted.

### 2. Use TodoWrite Effectively

Break down complex work:
```markdown
- [ ] Understand authentication flow
- [ ] Add token validation
- [ ] Update error handling
- [ ] Add tests
- [ ] Update documentation
```

### 3. Review Before Moving Forward

At each review checkpoint, actually review:
- Don't rubber-stamp
- Look for issues
- Verify assumptions
- Check edge cases

### 4. Simplify Meaningfully

Code-simplifier agent should:
- Reduce cognitive load
- Improve clarity
- Not change behavior
- Not over-abstract

### 5. Verify Comprehensively

Before creating PR:
- Run all checks locally
- Test manually
- Review diff completely
- Verify commit messages

## Troubleshooting

### Agent Skips Review Phases

**Problem**: Agent proceeds without reviewing plan/implementation

**Solution**:
- Prompt engineering: Emphasize review phases
- Make review phases explicit decision points
- Add self-review checklists

### Agent Over-Uses Subagents

**Problem**: Using Task tool for simple operations

**Solution**:
- Clear guidelines on when to use subagents
- Emphasize direct tool use for simple tasks
- Monitor and adjust prompts

### Agent Asks for Input (Ratchet)

**Problem**: Ratchet agent asks user for decisions

**Solution**:
- Strengthen autonomous operation language
- Add decision-making examples
- Remove conditional phrasing

### Simplification Changes Behavior

**Problem**: Code-simplifier agent breaks tests

**Solution**:
- Always run tests after simplification
- Return to implementation review if tests fail
- Refine simplification instructions

## Metrics to Track

When evaluating orchestrated workflows:

1. **Code Quality**
   - Test coverage
   - Type safety
   - Complexity metrics
   - Code review feedback

2. **Development Speed**
   - Time to PR creation
   - Time to merge
   - Rework cycles

3. **PR Quality**
   - Description clarity
   - Commit atomicity
   - Review iterations needed

4. **Agent Efficiency**
   - Context window usage
   - Subagent invocations
   - Tool call efficiency

## Future Enhancements

Potential improvements to consider:

1. **Parallel Phase Execution**
   - Run tests while simplifying
   - Parallel investigation paths

2. **Dynamic Phase Selection**
   - Skip simplification for trivial changes
   - Extend investigation for complex bugs

3. **Cross-Workflow Learning**
   - Share patterns between workflows
   - Build knowledge base of fixes

4. **Enhanced Subagent Coordination**
   - Better handoff protocols
   - Shared context management

## Questions and Feedback

For questions or feedback about orchestrated workflows:
1. Check workflow comments and guidelines
2. Review ORCHESTRATION_GUIDE.md (this file)
3. Open GitHub issue with workflow tag
4. Share findings with team

## Summary

Orchestrated workflows represent a more disciplined, review-driven approach to agent development:

- **Plan** before implementing
- **Review** at every stage
- **Simplify** before shipping
- **Orchestrate** complex work with subagents
- **Verify** comprehensively before PR

This systematic approach produces higher quality code, clearer PRs, and more maintainable results.
