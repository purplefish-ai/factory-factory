# How to Use Orchestrated Workflows

This guide explains how to use the orchestrated workflows when working with GitHub issues in the Kanban board.

## Quick Start

### Using the Kanban Board (Recommended)

1. **Navigate to your project's Kanban board**
   - Go to Projects → Select your project → Kanban tab

2. **Find an issue in the "ISSUES" column**
   - These are GitHub issues assigned to you

3. **Click the "Play" button on any issue**
   - The system automatically reads the issue labels
   - Selects the appropriate orchestrated workflow:
     - **Bug issues** (with "bug" label) → `bugfix-orchestrated`
     - **Feature issues** (other labels) → `feature-orchestrated`
   - Creates a workspace with the orchestrated agent

4. **Let the agent work**
   - The orchestrated agent will follow its workflow phases
   - You can monitor progress in the chat
   - The agent will create a PR when done

## What Happens Behind the Scenes

### For Bug Issues (with "bug" label)

The `bugfix-orchestrated` workflow runs:

1. **Investigation** - Agent investigates root cause systematically
2. **Investigation Review** - Agent verifies understanding
3. **Write Failing Test** - Proves bug exists (TDD approach)
4. **Implement Fix** - Minimal change to fix the bug
5. **Implementation Review** - Self-review of the fix
6. **Simplification** - Clean up the fix if needed
7. **Verification** - Comprehensive testing
8. **PR Creation** - Clear documentation of bug, cause, and fix

### For Feature Issues (without "bug" label)

The `feature-orchestrated` workflow runs:

1. **Planning** - Create implementation plan with TodoWrite
2. **Plan Review** - Validate plan before coding
3. **Implementation** - Execute the plan
4. **Implementation Review** - Self-review implementation
5. **Simplification** - Clean up code with code-simplifier agent
6. **Final Verification** - Run all checks
7. **PR Creation** - Clear summary and testing notes

## Manual Workflow Selection

You can also manually select workflows when creating a session:

1. **Create a workspace** (not from GitHub issue)
2. **Create a new session**
3. **Select workflow** from dropdown:
   - `feature-orchestrated` - For implementing features
   - `bugfix-orchestrated` - For fixing bugs
   - `ratchet-orchestrated` - For autonomous PR progression
   - `followup` - For free-form chat

## Labeling Your GitHub Issues

To get the most out of automatic workflow selection:

1. **Add "bug" label** to all bug reports
   - Case-insensitive: "bug", "Bug", "BUG" all work
   - Triggers test-driven bug fix workflow

2. **Use descriptive labels** for features
   - "enhancement", "feature", "improvement", etc.
   - Triggers planning-focused feature workflow

3. **Multiple labels are fine**
   - Only "bug" label affects workflow selection
   - Other labels are for your organization

## What Makes Orchestrated Workflows Different?

### Traditional Approach
```
Agent does everything in one go:
- Searches, reads, implements, tests, creates PR
- No structured planning or review
- No code simplification
- Limited self-reflection
```

### Orchestrated Approach
```
Main agent coordinates through phases:
1. Plan the work
2. Review the plan
3. Implement
4. Review implementation
5. Simplify code
6. Verify everything
7. Create PR

Uses specialized subagents:
- Plan agent for architecture review
- Explore agent for deep research
- Code-simplifier agent for cleanup
```

## Workflow Comparison

| Aspect | Traditional | Orchestrated |
|--------|------------|--------------|
| Planning | Implicit | Explicit phase with TodoWrite |
| Review | None | Multiple review checkpoints |
| Simplification | None | Dedicated agent phase |
| Verification | Basic | Comprehensive multi-step |
| Subagents | Ad-hoc | Strategic orchestration |
| Bug Fixes | Direct fix | Test-driven (failing test first) |
| Code Quality | Variable | Systematically ensured |

## Monitoring Agent Progress

When an orchestrated agent is working:

1. **Watch the chat** for phase transitions
   - "Phase 1: Planning..."
   - "Phase 2: Plan Review..."
   - etc.

2. **Check TodoWrite updates** (for feature workflow)
   - Agent creates task list
   - Marks tasks complete as it works

3. **Review implementation decisions**
   - Agent explains its choices
   - You can redirect if needed

4. **Verify final PR**
   - Comprehensive description
   - Clear testing notes
   - All checks passing

## Troubleshooting

### Issue: Agent doesn't seem orchestrated

**Problem**: Agent is working but not following phases

**Solution**: Check the session's workflow setting
- May be using non-orchestrated workflow (`feature`, `bugfix`, etc.)
- Create new session with orchestrated workflow selected

### Issue: Wrong workflow selected

**Problem**: Bug issue got feature workflow or vice versa

**Solution**: Check GitHub issue labels
- Bug issues need "bug" label (case-insensitive)
- Can manually create session with correct workflow

### Issue: Agent asks too many questions

**Problem**: Agent pausing for user input frequently

**Solution**: This is normal for complex tasks
- Agent asks when requirements unclear
- Provide clear answers to help agent proceed
- For autonomous operation, use `ratchet-orchestrated`

### Issue: Agent skips simplification

**Problem**: Code wasn't simplified

**Solution**: Simplification is conditional
- Skipped for simple changes (< 10 lines)
- Skipped if time-sensitive
- Manually request if desired: "Please simplify this code"

## Best Practices

### For Best Results

1. **Write clear GitHub issues**
   - Describe the problem/feature clearly
   - Include acceptance criteria
   - Add relevant context/links

2. **Label issues consistently**
   - Always use "bug" for bugs
   - Use consistent labels for features

3. **Let agents complete phases**
   - Don't interrupt during planning
   - Wait for PR creation before reviewing
   - Trust the orchestration process

4. **Review final PRs carefully**
   - Orchestrated ≠ perfect
   - Check implementation details
   - Verify tests are meaningful

### For Manual Sessions

1. **Choose workflow based on task**
   - Bug fixing → `bugfix-orchestrated`
   - New feature → `feature-orchestrated`
   - PR fixes → `ratchet-orchestrated`
   - Exploration → `followup`

2. **Provide context upfront**
   - Paste relevant code/errors
   - Link to related issues/PRs
   - Explain desired outcome

3. **Monitor and guide**
   - Watch for plan issues early
   - Redirect if approach wrong
   - Provide clarifications promptly

## Advanced Usage

### Resuming Orchestrated Work

If a workspace has an incomplete orchestrated session:

1. **Open the workspace**
2. **Review the last phase completed**
3. **Continue from where agent left off**
   - Agent maintains context
   - Resumes orchestration naturally

### Switching Workflows Mid-Session

If you realize wrong workflow was selected:

1. **Create new session** in same workspace
2. **Select correct workflow**
3. **Agent will start fresh**
   - Previous work is preserved
   - Can reference prior attempts

### Customizing Orchestration

Currently, orchestration phases are fixed. Future enhancements may allow:
- Skipping phases (e.g., skip simplification)
- Extending phases (e.g., more review rounds)
- Custom phase ordering

## Feedback and Iteration

The orchestrated workflows are designed to evolve:

1. **Share feedback** on workflow effectiveness
2. **Report issues** with agent behavior
3. **Suggest improvements** to phases or prompts

Your usage and feedback will help refine the orchestrated approach!

## Summary

**To use orchestrated workflows:**
1. Click "play" on GitHub issues in Kanban board
2. System automatically selects appropriate workflow
3. Agent follows structured phases with review
4. Produces high-quality PRs with clear documentation

**Key benefits:**
- Systematic planning and review
- Test-driven bug fixes
- Code simplification before shipping
- Comprehensive verification
- Clear, well-documented PRs

**Remember:**
- Bug label → bugfix workflow (TDD approach)
- Other labels → feature workflow (planning + review)
- Manual workspaces → followup workflow (free-form)
