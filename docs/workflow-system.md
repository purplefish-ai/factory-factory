# How Workflows Work in Conductor

This document explains the workflow system - how selecting a workflow influences Claude sessions and subsequent tabs.

## Overview

Workflows are **system prompt templates** that guide Claude's behavior during a coding session. When you select a workflow, its content becomes part of Claude's system prompt, shaping how it approaches your task.

## The Four Workflows

| Workflow | Purpose | Expects PR? |
|----------|---------|-------------|
| **Feature** | End-to-end implementation with PR creation | Yes |
| **Bug Fix** | Investigate and fix bugs with regression tests | Yes |
| **Explore** | Understand codebase structure and answer questions | No |
| **Follow-up** | Continue previous work or handle ad-hoc tasks | No |

## When Workflow Selection Appears

The workflow selector only appears when a workspace has **zero sessions**. This is the first tab you create in a new workspace.

```
New Workspace → Workflow Selector → First Session Created
```

## How Workflows Influence Claude

### 1. System Prompt Injection

When a session starts, the workflow content is passed to Claude CLI via `--append-system-prompt`:

```
Workflow File (e.g., feature.md)
         ↓
    [Parsed content]
         ↓
ClaudeProcess.spawn({ systemPrompt: workflowContent })
         ↓
claude --append-system-prompt "# Feature Implementation Workflow..."
```

### 2. What Each Workflow Tells Claude

**Feature Workflow:**
- Understand requirements first
- Create a task list with TodoWrite
- Implement with atomic commits
- Run tests (`pnpm test`)
- Verify build (`pnpm typecheck`, `pnpm check:fix`)
- Create a PR when done

**Bug Fix Workflow:**
- Reproduce the bug first
- Investigate root cause (not just symptoms)
- Write a failing test BEFORE fixing
- Make minimal changes
- Include regression tests
- Create a PR with reproduction steps

**Explore Workflow:**
- Start with entry points
- Use Grep/Glob effectively
- Build mental models
- Document findings with file paths and line numbers
- Use Task tool for deep dives

**Follow-up Workflow:**
- Review conversation history
- Check git status for uncommitted changes
- Look at TodoWrite list for pending tasks
- Resume gracefully without repeating work

## How Subsequent Tabs Work

### Key Insight: Each tab is independent

When you open a new tab (after the first session exists):
- **No workflow selector appears** - it goes directly to a chat
- **Workflow is automatically set to `followup`**
- Each tab maintains its own workflow and Claude session

### The Flow

```
Workspace with existing sessions:
  ├── Tab 1 (feature workflow) - your first session
  ├── Tab 2 (followup workflow) - created via "New Chat"
  ├── Tab 3 (followup workflow) - created via Quick Action
  └── Tab 4 (followup workflow) - another new tab
```

### Why Follow-up is Default

The system tracks whether a workspace has ever had sessions (`hasHadSessions` flag):

```typescript
// First session in workspace
recommendedWorkflow = 'feature'

// Any subsequent session
recommendedWorkflow = 'followup'
```

The follow-up workflow is designed for continuation - it tells Claude to:
- Check git status for context
- Review what was completed
- Resume without repeating work

## Technical Details

### Storage

Workflows are stored per-session in the database:

```prisma
model ClaudeSession {
  workflow  String  // "feature", "bugfix", "explore", "followup"
  // ...
}
```

### Workflow Files

Located in `prompts/workflows/`:
- `feature.md`
- `bugfix.md`
- `explore.md`
- `followup.md`

Each has YAML frontmatter:
```yaml
---
name: Feature
description: End-to-end feature implementation with PR creation
expectsPR: true
---
```

### Adding New Workflows

To add a workflow:
1. Create `prompts/workflows/my-workflow.md` with frontmatter
2. Update `workflow-selector.tsx` to add an icon for the new ID
3. The system auto-discovers workflows from the directory

## Common Questions

### Q: Can I change a session's workflow after creation?

No, the workflow is set when the session is created and becomes part of the system prompt for that session.

### Q: Do tabs in the same workspace share context?

No, each tab is a separate Claude session with its own:
- Conversation history
- System prompt (workflow)
- Claude session ID (for resume)

They share the same workspace (git worktree), but not conversation context.

### Q: What if I want a new Feature workflow session?

Currently, you'd need to create a new workspace. The workflow selector only appears for the first session. Future enhancement: allow workflow selection for any new tab.

### Q: Does the workflow affect which model is used?

No, model selection is separate. All workflows default to Sonnet but can be changed in the session.
