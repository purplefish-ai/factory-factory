# Planning Mode - Design Document

## Overview

Planning Mode is a new workspace workflow that enables collaborative planning between the user and the AI agent. Instead of the agent executing code changes, it focuses on producing a structured plan document (markdown) through conversation. The plan is persisted to the filesystem and rendered in a split-pane view alongside the chat. Once the plan is finalized, it can be decomposed into tickets in the project's ticketing system.

## Motivation

Today, workspaces are optimized for **execution**: the agent reads code, writes code, runs tests, and creates PRs. But many tasks require a **planning phase** before execution - architecture decisions, feature breakdowns, migration strategies, etc. Currently, planning happens ad-hoc in chat, with no persistent artifact. Planning Mode formalizes this by:

1. Providing a dedicated workspace mode focused on producing a plan document
2. Giving the agent read-only filesystem access (no accidental changes during planning)
3. Rendering the plan as a live document alongside the chat (read-only; user directs changes via chat)
4. Enabling the transition from plan to action via ticket creation

## User Experience

### Entering Planning Mode

Planning mode is a **workflow** (like `feature`, `explore`, `bugfix`). When a user creates a new workspace session, they select the "Plan" workflow from the workflow selector.

The workflow selector will show:
- **Plan** - Collaboratively create a structured plan document

**Note**: Planning mode is only available via the workflow selector. It is not triggerable mid-conversation. This keeps the entry point explicit and predictable.

### The Planning View

When a planning session is active, the workspace layout changes to a split-pane view:

```
+-------------------------------------------+-----------------------------+
|                                           |                             |
|              Chat Panel                   |       Plan Document         |
|                                           |                             |
|  User: I want to plan the auth system     |  # Auth System Plan         |
|                                           |                             |
|  Agent: Great! Let me start by            |  ## Overview                |
|  understanding the current state...       |  Migrate from session-based |
|  [reads files]                            |  to JWT authentication.     |
|                                           |                             |
|  Agent: I've created an initial plan.     |  ## Phase 1: Token Service  |
|  What do you think about the phased       |  - Create JWT utility       |
|  approach?                                |  - Add refresh tokens       |
|                                           |                             |
|  User: Can we add a migration phase?      |  ## Phase 2: Migration      |
|                                           |  ...                        |
|  > [chat input]                           |                             |
|                                           |  [rendered] [raw] [toggle]  |
+-------------------------------------------+-----------------------------+
```

**Key UI elements:**
- **Left panel (Chat)**: Standard chat interface. The agent can read files, explore the codebase, and discuss the plan with the user.
- **Right panel (Plan Document)**: Renders the plan markdown file. Supports toggling between **rendered** (markdown preview) and **raw** (read-only markdown source) views. Starts in rendered mode. The user does **not** edit the plan directly - all changes are directed through chat with the agent.
- **Plan header**: Shows the filename, last-updated timestamp, and view toggle.

### Agent Behavior in Planning Mode

The agent:
- **CAN** read files from the workspace filesystem (Glob, Grep, Read)
- **CAN** write/update the plan document (a specific file in the workspace)
- **CANNOT** edit any other files in the workspace
- **CANNOT** run shell commands (Bash)
- **CAN** ask the user questions (AskUserQuestion)

This is enforced by the existing permission system: a custom permission handler for planning sessions that allows read-only tools + plan file writes only.

### Plan Document Lifecycle

1. **Creation**: When the planning session starts, a markdown file is created at:
   ```
   <workspace-root>/planning/<YYYY-MM-DD-HHMM>-<branch-name>.md
   ```
   Example: `planning/2026-02-05-1430-auth-system-redesign.md`

2. **Updates**: As the conversation progresses, the agent updates the plan file. Each update is reflected live in the right panel.

3. **Title**: The filename stays fixed (timestamp + branch name). The plan's display title is parsed from the first `# heading` in the markdown, which the agent sets naturally as part of writing the plan. The UI shows this heading as the plan title in the panel header.

4. **Multi-session**: If a new planning session starts in the same workspace, the agent scans `planning/` for existing plan files and offers to continue an existing plan or start a fresh one.

5. **Completion**: When the user and agent agree the plan is complete, the agent can:
   - Create tickets in the ticketing system (Linear/GitHub Issues)
   - The plan file remains committed in the repository for reference

### Ticket Creation Flow

The primary ticketing target is **GitHub Issues**, with the architecture designed to easily add other systems (Linear, Jira, etc.) behind a common service interface.

Once the plan is finalized:

1. The agent proposes a set of GitHub Issues derived from the plan sections
2. The user reviews and adjusts the ticket breakdown (via `AskUserQuestion`)
3. The agent creates the issues via a dedicated backend ticket service
4. Each issue links back to the plan document
5. The plan document is updated with issue references

**No automatic workspace creation** from tickets - users create workspaces manually from the Kanban board as usual. This keeps the first version simple.

## Technical Design

### 1. New Workflow: `plan`

**File**: `prompts/workflows/plan.md`

```yaml
---
name: Plan
description: Collaboratively create a structured plan document
expectsPR: false
---
```

The workflow prompt will instruct the agent on:
- How to structure plans (sections, phases, acceptance criteria)
- When and how to update the plan file
- How to rename the file as purpose becomes clear
- How to propose tickets at the end
- That it has read-only filesystem access (except the plan file)

### 2. Permission Handler: Planning Mode

**Approach**: Extend the existing permission system.

The existing `permissionMode: 'plan'` in Claude CLI is close but not exactly what we need. Claude's built-in plan mode is about requiring approval before tool execution, while our planning mode is about restricting which tools can be used.

**Option A (Recommended)**: Use `permissionMode: 'default'` with a custom PreToolUse hook that:
- Auto-allows: `Glob`, `Grep`, `Read`, `TodoWrite`, `AskUserQuestion`, `Task`
- Auto-allows: `Write` and `Edit` only when the target path is within `<workspace>/planning/`
- Auto-denies: `Bash`, `Write`/`Edit` outside planning dir
- This keeps the agent's tool palette unrestricted for reading, but prevents writes

**Implementation**: Add a planning-mode permission handler in `src/backend/claude/permissions.ts` that checks the tool input path for write operations.

### 3. Plan File Management

**New service**: `src/backend/services/plan-file.service.ts`

Responsibilities:
- Create initial plan file on session start
- Watch for file changes (via filesystem watcher or polling)
- Serve plan file content to the frontend via tRPC
- Handle file renames (update DB reference)

**Database changes**: Add to `ClaudeSession`:
```prisma
model ClaudeSession {
  // ... existing fields ...
  planFilePath    String?   // Relative path to the plan file (e.g., "planning/2026-02-05-auth-redesign.md")
}
```

### 4. Frontend: Plan Panel Component

**New component**: `src/components/workspace/plan-panel.tsx`

This replaces the standard right panel when a planning session is active.

```typescript
interface PlanPanelProps {
  workspaceId: string;
  sessionId: string;
  planFilePath: string;
}
```

**Features**:
- Fetches plan content via tRPC query (with polling or WebSocket subscription for live updates)
- Rendered mode: Uses the existing `MarkdownRenderer` component from `src/components/ui/markdown.tsx`
- Raw mode: Shows the markdown source in a read-only code editor (or `<pre>` block)
- Toggle between rendered/raw views (reuse existing `PlanViewMode` from `src/components/chat/plan-view-preference.ts`)
- Shows filename and last-updated timestamp in a header bar

### 5. Layout Changes

**File**: `src/client/routes/projects/workspaces/workspace-detail-view.tsx`

When the active session's workflow is `plan`, the right panel renders `PlanPanel` instead of the standard `RightPanel`.

The split should be roughly 50/50 for planning mode (instead of the 70/30 default), since the plan document is the primary output.

```tsx
<ResizablePanelGroup direction="horizontal" autoSaveId="workspace-main-panel">
  <ResizablePanel defaultSize={isPlanningMode ? "50%" : "70%"} minSize="30%">
    {/* Chat content */}
  </ResizablePanel>
  <ResizableHandle />
  <ResizablePanel defaultSize={isPlanningMode ? "50%" : "30%"} minSize="15%" maxSize="70%">
    {isPlanningMode ? (
      <PlanPanel workspaceId={workspaceId} sessionId={sessionId} planFilePath={planFilePath} />
    ) : (
      <RightPanel workspaceId={workspaceId} messages={messages} />
    )}
  </ResizablePanel>
</ResizablePanelGroup>
```

The right panel should **always be visible** in planning mode (no toggle to hide it).

### 6. Plan File Content Delivery

**Option A (Recommended)**: tRPC query with polling

Add a tRPC endpoint that reads the plan file from disk:

```typescript
// src/backend/trpc/workspace.trpc.ts (or new plan.trpc.ts)
getPlanContent: publicProcedure
  .input(z.object({ workspaceId: z.string(), filePath: z.string() }))
  .query(async ({ input }) => {
    const workspace = await workspaceAccessor.findById(input.workspaceId);
    const fullPath = path.join(workspace.worktreePath, input.filePath);
    // Security: validate path is within workspace
    const content = await fs.readFile(fullPath, 'utf-8');
    return { content, lastModified: stat.mtime.toISOString() };
  }),
```

The frontend polls this every 1-2 seconds during active planning sessions.

**Option B**: WebSocket notifications when the agent writes to the plan file, triggering a refetch. More complex but lower latency.

### 7. Agent Instructions (Workflow Prompt)

The plan workflow prompt (`prompts/workflows/plan.md`) should instruct the agent to:

1. Check `planning/` for existing plan files; if found, ask the user whether to continue an existing plan or start fresh
2. Start by understanding the user's goal
3. Explore the codebase to gather relevant context
4. Create a structured plan document with clear sections:
   - `# Plan Title` (first heading - used as display name in UI)
   - Overview / Goal
   - Current State (what exists today)
   - Proposed Changes (phases or workstreams)
   - Per-phase: description, files affected, acceptance criteria
   - Open Questions
   - Risks and Mitigations
5. Update the plan as the conversation progresses
6. When the user indicates the plan is complete, propose a ticket breakdown
7. Create GitHub Issues after user approval via `AskUserQuestion`

### 8. Ticket Creation Service

The primary ticketing system is **GitHub Issues**, with the architecture designed for easy extensibility to other systems.

**New service**: `src/backend/services/ticket.service.ts`

A thin service layer that abstracts ticket creation behind an interface:

```typescript
interface TicketService {
  createIssue(params: {
    workspaceId: string;
    title: string;
    body: string;
    labels?: string[];
    milestone?: string;
  }): Promise<{ number: number; url: string }>;
}
```

**GitHub implementation** (initial):
```typescript
class GitHubTicketService implements TicketService {
  async createIssue(params) {
    // Uses githubCLIService internally
    return await githubCLIService.createIssue(params);
  }
}
```

**tRPC endpoint**: Exposes ticket creation to the agent via a tool or directly:

```typescript
createTicketFromPlan: publicProcedure
  .input(z.object({
    workspaceId: z.string(),
    title: z.string(),
    body: z.string(),
    labels: z.array(z.string()).optional(),
  }))
  .mutation(async ({ input }) => {
    return await ticketService.createIssue(input);
  }),
```

Adding Linear or other systems later is a matter of implementing the `TicketService` interface and adding a user setting to choose the provider.

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `prompts/workflows/plan.md` | Planning workflow prompt |
| `src/components/workspace/plan-panel.tsx` | Plan document panel component |
| `src/backend/services/plan-file.service.ts` | Plan file management service |
| `src/backend/services/ticket.service.ts` | Ticket creation service (GitHub Issues, extensible) |
| `src/backend/trpc/plan.trpc.ts` | tRPC router for plan content + ticket creation |

### Modified Files
| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `planFilePath` to `ClaudeSession` |
| `src/backend/claude/permissions.ts` | Add planning-mode permission handler |
| `src/client/routes/projects/workspaces/workspace-detail-view.tsx` | Conditional plan panel layout |
| `src/backend/trpc/app-router.ts` | Register new `plan` tRPC router |
| `src/backend/services/session.prompt-builder.ts` | Build planning-specific system prompt |
| `src/components/workspace/workspace-content-view.tsx` | Pass planning mode state |

### Migration
- Prisma migration to add `planFilePath` column to `ClaudeSession`

## Design Decisions (Resolved)

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| Plan panel editing | **Chat-only** | Agent is sole author. User directs changes via chat. Simpler UX, clear ownership. |
| Ticketing system | **GitHub Issues** (primary) | Start with GitHub Issues. Service interface makes adding Linear/etc. easy later. |
| Plan-to-execution | **Tickets only** | No auto-creation of workspaces. Users create workspaces manually. Simpler first version. |
| Entry point | **Workflow selector only** | Explicit, predictable entry. No mid-conversation mode switching. |
| Plan versioning | **Git history only** | No version UI. Agent can commit checkpoints naturally. User can `git diff`/`git log` if needed. |
| Multi-session planning | **Detect and offer** | Agent checks `planning/` dir on session start, offers to continue an existing plan or start fresh. No backend changes needed. |
| Plan display name | **Parse from `#` heading** | Keep original filename (timestamp+branch). Display the first `# heading` from the plan file as the title in the UI. Zero extra machinery. |
