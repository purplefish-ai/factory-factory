# Claude UI Design Specification

## Overview

A three-column desktop application for managing multiple Claude Code sessions across git worktrees. Inspired by [conductor.build](https://conductor.build), the UI emphasizes parallel agent execution with clear visibility into workspace state, conversations, and code changes.

---

## Layout Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Menu Bar                                                                   │
├──────────────┬────────────────────────────────────┬─────────────────────────┤
│              │  Tab: main ◉  Tab: auth.ts ×       │                         │
│  WORKSPACES  │────────────────────────────────────│  FILE CHANGES           │
│              │                                    │                         │
│  ▼ my-app [+]│  Claude Conversation               │  ─ Staged (2) ──────────│
│    ◉ main    │                                    │   M src/auth.ts    +15-3│
│      2m ago  │  ┌─────────────────────────────┐   │   A src/login.tsx  +45  │
│      +12 -3  │  │ User: Fix the login bug     │   │  [Unstage All] [Commit] │
│              │  └─────────────────────────────┘   │                         │
│    ○ feature │                                    │  ─ Unstaged (1) ────────│
│      15m ago │  ┌─────────────────────────────┐   │   M src/utils.ts   +2 -1│
│      +45 -12 │  │ Assistant: I'll investigate │   │  [Stage All] [Discard]  │
│              │  │ the authentication flow...  │   │                         │
│  ▼ api-svc[+]│  │                             │   │                         │
│    ○ main    │  │ ▼ Task: Explore auth        │   │                         │
│    ○ hotfix  │  │   Reading src/auth.ts...    │   │                         │
│              │  │                             │   │                         │
│              │  └─────────────────────────────┘   │                         │
│              │                                    │                         │
│              │  ┌─────────────────────────────┐   │                         │
│              │  │ 🔧 Bash: npm test      1/2  │   │                         │
│              │  │ [Allow]  [Deny]             │   │                         │
│              │  └─────────────────────────────┘   │                         │
│              │────────────────────────────────────│                         │
│              │  > Send a message...          [⏎] │                         │
├──────────────┴────────────────────────────────────┴─────────────────────────┤
│  ● Connected │ Context: 45k/200k │ Cost: $0.23 │ Model: opus-4.5           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Column Widths:**
- Left (Workspaces): ~220px, resizable
- Middle (View Pane): Flex, takes remaining space
- Right (File Changes): ~280px, resizable

---

## Column 1: Workspaces (Left)

### Purpose
Navigate and manage repositories and their associated git worktrees. Each worktree represents an isolated working environment with its own Claude session.

### Data Model

```typescript
interface Workspace {
    id: string;
    repoPath: string;              // Parent repository path
    repoName: string;              // Display name (e.g., "my-app")
    worktrees: Worktree[];
}

interface Worktree {
    id: string;
    path: string;                  // Worktree directory path
    branch: string;                // Current branch name
    isActive: boolean;             // Currently selected in UI
    lastUsed: Date;                // Last interaction timestamp
    deltas: {
        staged: number;            // Staged file count
        unstaged: number;          // Unstaged changes count
        ahead: number;             // Commits ahead of remote
        behind: number;            // Commits behind remote
    };
    claudeSession?: {
        sessionId: string;
        status: 'idle' | 'running' | 'awaiting_approval' | 'error';
        lastMessage?: string;      // Preview of last assistant message
    };
}
```

### Visual Elements

| Element | Description |
|---------|-------------|
| Repository header | Collapsible, shows repo name with expand/collapse chevron |
| Worktree item | Branch name, time since last use, delta summary |
| Status indicator | ◉ active, ○ inactive, ⟳ syncing, ⚠ needs attention |
| Delta badge | `+N -M` showing insertions/deletions |
| Quick actions | Hover: new worktree, delete, open in finder |

### Interactions

- **Click worktree**: Switch active worktree, load its Claude session in middle pane
- **Plus button (+)**: Quick-create new worktree (appears next to workspace header)
- **Right-click worktree**: Context menu (delete worktree, open in finder)
- **Right-click workspace**: Context menu (remove workspace, open in finder)

### Quick Worktree Creation

The **+** button next to each workspace header triggers inline worktree creation:

```
┌─────────────────────────────────────────┐
│ ▼ my-app                            [+] │
│   ◉ main                                │
│   ○ feature-auth                        │
│   ┌─────────────────────────────────┐   │
│   │ Branch name: feature-           │   │
│   │ [Create] [Cancel]               │   │
│   └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- Single text input for branch name
- Creates worktree at `../<repo>-<branch>` by default
- Runs: `git worktree add ../<repo>-<branch> -b <branch>`
- On success: switches to new worktree, opens Claude tab

### State Sync

Worktree state should refresh:
- On focus (app becomes active)
- Every 30 seconds while visible
- After any Claude tool execution that modifies files
- On git operations detected via file watcher

---

## Column 2: View Pane (Middle)

### Purpose
The primary content area. Displays different view types depending on context: Claude conversations, file diffs, images, or other content. This is the "view layer" of the application.

### Tab Management

```typescript
type ViewTab =
    | { type: 'claude'; worktreeId: string; sessionId?: string; status: TabStatus }
    | { type: 'diff'; worktreeId: string; filePath: string; staged: boolean }
    | { type: 'image'; worktreeId: string; filePath: string }
    | { type: 'file'; worktreeId: string; filePath: string };

type TabStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'error';

interface Tab {
    id: string;
    view: ViewTab;
    title: string;                 // Branch name, filename, etc.
    unreadCount: number;           // For claude tabs: messages since last viewed
    closable: boolean;             // Claude tabs may prompt before close
}
```

- **Claude tabs**: One per active worktree, shows conversation
- **Diff tabs**: Opened by clicking a file in the right column
- **Image tabs**: Opened when viewing image tool results
- Tab title derived from content (branch name, filename)
- Close tab: Claude tabs prompt to interrupt if session active

### View Types

#### Claude Conversation View
The default view for a worktree. Full conversation UI with messages, tool use, approvals.

### Message Types

#### User Message
```
┌─────────────────────────────────────────┐
│ Fix the authentication bug in login.tsx │
└─────────────────────────────────────────┘
```

#### Assistant Message (Text)
```
┌─────────────────────────────────────────┐
│ I'll investigate the authentication     │
│ flow and identify the bug.              │
│                                         │
│ Let me start by reading the login       │
│ component...                            │
└─────────────────────────────────────────┘
```

#### Tool Use (Collapsible)
```
┌─────────────────────────────────────────┐
│ ▼ Read: src/components/Login.tsx        │
│ ┌─────────────────────────────────────┐ │
│ │ 1  import { useState } from 'react' │ │
│ │ 2  import { auth } from '../lib'    │ │
│ │ ...                                 │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### Subagent (Nested, Collapsible)
```
┌─────────────────────────────────────────┐
│ ▼ Task: Explore authentication code     │
│   │                                     │
│   │ Searching for auth-related files... │
│   │                                     │
│   │ ▶ Read: src/lib/auth.ts            │
│   │ ▶ Read: src/middleware/session.ts  │
│   │                                     │
│   │ Found 3 files related to auth...   │
│   │                                     │
└─────────────────────────────────────────┘
```

#### Approval Prompt (Stacked, One at a Time)

Approvals appear at the bottom of the conversation, one at a time. If multiple approvals queue up, show a counter but only display the current one.

```
┌─────────────────────────────────────────┐
│ 🔧 Bash Command                    1/3  │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ npm install jsonwebtoken            │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Description: Install JWT library        │
│                                         │
│ [Allow]  [Deny]                         │
└─────────────────────────────────────────┘
```

- **1/3**: Shows position in queue if multiple pending
- **Allow**: Send allow response, advance to next
- **Deny**: Send deny response, advance to next
- Simple two-button UI, no "remember" complexity for now

### Input Area

```
┌─────────────────────────────────────────┐
│ > Type a message...                 [⏎] │
├─────────────────────────────────────────┤
│ [📎 Attach] [/] [⚙️ Settings]           │
└─────────────────────────────────────────┘
```

- **Attach**: Add files/images to context
- **/** : Slash command autocomplete
- **Settings**: Model selection, permission mode toggle

### Streaming Behavior

1. **Text streaming**: Append characters as `content_block_delta` arrives
2. **Tool use**: Show tool name immediately on `content_block_start`, expand input on completion
3. **Subagent**: Create nested container on Task tool_use, stream child content inside
4. **Approval**: Float/sticky at bottom until resolved

#### Diff View

Opened when clicking a file in the right column. Uses a split or unified diff display.

```
┌─ src/auth.ts (staged) ──────────────────┐
│                                          │
│  14   import { verify } from 'jsonweb... │
│  15                                      │
│  16 - function validateToken(token) {   │
│  16 + function validateToken(token: st.. │
│  17     if (!token) {                    │
│  18 -     return false;                  │
│  18 +     throw new AuthError('Missing.. │
│  19     }                                │
│                                          │
│ ─────────────────────────────────────────│
│ [Stage] [Discard] [Open File]            │
└──────────────────────────────────────────┘
```

- **Header**: Filename with staged/unstaged indicator
- **Diff content**: Syntax-highlighted with +/- markers
- **Actions**: Stage/unstage, discard changes, open in editor

#### Image View

Opened when viewing image content from tool results or clicking an image file.

```
┌─ screenshot.png ────────────────────────┐
│                                          │
│         ┌──────────────────┐             │
│         │                  │             │
│         │     [image]      │             │
│         │                  │             │
│         └──────────────────┘             │
│                                          │
│  1920 × 1080 · 245 KB · PNG              │
└──────────────────────────────────────────┘
```

---

## Column 3: File Changes (Right)

### Purpose
Show git changes for the active worktree. Clicking a file opens a diff tab in the middle pane.

### Data Model

```typescript
interface FileChange {
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
    staged: boolean;
    insertions: number;
    deletions: number;
}
```

### Visual Layout

```
┌─ Staged (2) ────────────────────────────┐
│  M src/auth.ts                     +15 -3│
│  A src/login.tsx                   +45   │
├──────────────────────────────────────────┤
│ [Unstage All] [Commit...]               │
├─ Unstaged (3) ──────────────────────────┤
│  M src/utils.ts                    +2 -1 │
│  M package.json                    +1    │
│  ? .env.local                            │
├──────────────────────────────────────────┤
│ [Stage All] [Discard All]               │
└──────────────────────────────────────────┘
```

### File Status Icons

| Icon | Status |
|------|--------|
| `A` | Added (new file) |
| `M` | Modified |
| `D` | Deleted |
| `R` | Renamed |
| `?` | Untracked |

### Interactions

- **Click file**: Open diff view in middle pane (new tab)
- **Checkbox toggle**: Stage/unstage individual file
- **Commit button**: Opens commit message input (inline or modal)
- **Stage All / Unstage All**: Bulk operations
- **Discard All**: Confirmation required, then `git checkout -- .`

### State Sync

File changes should refresh:
- On worktree switch
- After Claude tool executions (Edit, Write, Bash)
- On file system changes (via watcher)
- Every 5 seconds as fallback

---

## Status Bar (Bottom)

Global status information across the application.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● Connected │ Context: 45,231 / 200,000 │ Cost: $0.23 │ Model: opus-4.5     │
│             │ ████████░░░░░░░░░░░░ 23%  │ Session     │ [▼ Change]          │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Element | Source | Update Frequency |
|---------|--------|------------------|
| Connection status | CLI process health | Real-time |
| Context usage | `message_delta.usage` | Per message |
| Cost | `result.total_cost_usd` | Per turn |
| Model | System init / user selection | On change |

---

## Theming (CSS Variables)

Use CSS custom properties for consistent styling. Dark theme only for initial implementation.

```css
:root {
    /* Background layers */
    --bg-base: #0d1117;           /* App background */
    --bg-surface: #161b22;        /* Cards, panels */
    --bg-elevated: #21262d;       /* Hover states, modals */
    --bg-overlay: #30363d;        /* Dropdowns, tooltips */

    /* Text */
    --text-primary: #e6edf3;      /* Primary content */
    --text-secondary: #8b949e;    /* Secondary, muted */
    --text-tertiary: #6e7681;     /* Disabled, hints */
    --text-link: #58a6ff;         /* Links, actions */

    /* Borders */
    --border-default: #30363d;    /* Default borders */
    --border-muted: #21262d;      /* Subtle dividers */

    /* Status colors */
    --status-success: #3fb950;    /* Success, additions */
    --status-warning: #d29922;    /* Warnings, pending */
    --status-error: #f85149;      /* Errors, deletions */
    --status-info: #58a6ff;       /* Info, running */

    /* Syntax highlighting (for diffs) */
    --diff-add-bg: rgba(63, 185, 80, 0.15);
    --diff-add-text: #3fb950;
    --diff-remove-bg: rgba(248, 81, 73, 0.15);
    --diff-remove-text: #f85149;

    /* Spacing scale */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 24px;
    --space-6: 32px;

    /* Typography */
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
    --font-size-sm: 12px;
    --font-size-base: 14px;
    --font-size-lg: 16px;

    /* Radii */
    --radius-sm: 4px;
    --radius-md: 6px;
    --radius-lg: 8px;

    /* Shadows */
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
    --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
}
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+1/2/3` | Focus column 1/2/3 |
| `Cmd+W` | Close current tab |
| `Cmd+Enter` | Send message |
| `Cmd+.` | Interrupt current execution |
| `Cmd+Shift+N` | New worktree |
| `Cmd+/` | Toggle slash command palette |
| `Escape` | Dismiss approval prompt (deny) |
| `Enter` | Accept approval prompt (when focused) |
| `Cmd+Shift+C` | Open commit dialog |

---

## State Management

### Global State

```typescript
interface AppState {
    workspaces: Workspace[];
    activeWorktreeId: string | null;

    // Per-worktree state (keyed by worktreeId)
    sessions: Map<string, SessionState>;
    terminals: Map<string, TerminalTab[]>;
}

interface SessionState {
    sessionId: string | null;
    messages: Message[];
    pendingApprovals: PendingApproval[];
    status: 'idle' | 'connecting' | 'running' | 'error';
    usage: UsageStats;
    cliProcess: ChildProcess | null;
}
```

### Persistence

| Data | Storage | Sync |
|------|---------|------|
| Workspaces | Local config file | On change |
| Window layout | Local preferences | On change |
| Conversation history | CLI session JSONL | Read-only (CLI owns) |
| Terminal history | In-memory | Not persisted |

---

## CLI Integration Points

### Process Lifecycle

1. **App launch**: Scan known workspace paths for worktrees
2. **Worktree select**: Spawn CLI process if no active session
3. **Tab close**: Send interrupt, wait for graceful exit, force kill if needed
4. **App quit**: Interrupt all sessions, wait max 5s, force kill

### Message Flow

```
User Input → SDK Message → CLI stdin
                              ↓
UI Update ← Parse Message ← CLI stdout
```

### Approval Handling

1. Receive `control_request` with `subtype: "can_use_tool"` or `"hook_callback"`
2. Display approval UI (floating at bottom of conversation)
3. On user decision, send `control_response`
4. Remove approval from pending queue

---

## Design Decisions

| Question | Decision |
|----------|----------|
| Diff viewer | Opens as tab in middle pane |
| Image display | Opens as tab in middle pane (click to expand from conversation) |
| Multiple approvals | One at a time with queue counter (1/3) |
| Worktree creation | Inline quick-create with + button |
| Theme | Dark-only, CSS variables for future flexibility |

## Open Questions

1. **Session resume**: Auto-resume last session on worktree select, or always fresh?
2. **Commit flow**: Inline in right column, or modal dialog?
3. **Column resize persistence**: Save column widths, or reset on app restart?

---

## Implementation Priority

### Phase 1: Core Loop
- [ ] Single workspace, single worktree
- [ ] Claude conversation view (text, tool use, tool result)
- [ ] Approval prompts (allow/deny, one at a time)
- [ ] Basic input with send
- [ ] Status bar (connection, context, cost)

### Phase 2: Multi-View
- [ ] Tab management in middle pane
- [ ] Diff view (open from file click)
- [ ] File changes column (staged/unstaged)
- [ ] Stage/unstage file actions

### Phase 3: Multi-Workspace
- [ ] Workspace sidebar with worktree list
- [ ] Worktree switching
- [ ] Quick worktree creation (+)
- [ ] Subagent nesting in conversation

### Phase 4: Polish
- [ ] Keyboard shortcuts
- [ ] Slash command palette
- [ ] Session resume/fork
- [ ] Commit workflow
- [ ] Image view
