# Architecture

## Overview

Single binary, three modules. Clean separation of concerns via TypeScript interfaces and event emitters.

```
┌─────────────────────────────────────────────────────────────┐
│                        claude-ui                            │
│                       (one binary)                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐    │
│  │    claude     │  │   workspace   │  │      ui       │    │
│  │    manager    │  │   manager     │  │               │    │
│  └───────┬───────┘  └───────┬───────┘  └───────────────┘    │
│          │                  │                   ▲           │
│          │   events         │   events          │           │
│          └──────────────────┴───────────────────┘           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Domain Model

```
┌─────────────────────────────────────────────────────────────┐
│                       Workspace                             │
│                    (a git repository)                       │
│                                                             │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│   │  Worktree   │  │  Worktree   │  │  Worktree   │        │
│   │   (main)    │  │ (feature-a) │  │ (feature-b) │        │
│   │             │  │             │  │             │        │
│   │  Session?   │  │  Session?   │  │  Session?   │        │
│   └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

- **Workspace**: A git repository. Has one or more worktrees.
- **Worktree**: A working directory with a branch checked out. May have an associated Claude session.
- **Session**: A Claude CLI process. Linked to a worktree's cwd.

---

## Modules

### 1. Workspace Manager (`src/workspace-manager/`)

Manages the workspace → worktree hierarchy and git operations.

**Responsibilities:**
- Track registered workspaces (repositories)
- List and create worktrees within workspaces
- Watch filesystem for file changes
- Compute staged/unstaged file lists
- Stage, unstage, discard files
- Generate diffs
- Create commits

**Does NOT know about:**
- Claude or AI sessions
- UI state or rendering

### 2. Claude Manager (`src/claude-manager/`)

Manages Claude CLI processes and the bidirectional protocol.

**Responsibilities:**
- Spawn and kill CLI processes
- Handle NDJSON streaming protocol
- Parse messages into typed events
- Manage session lifecycle (create, resume, fork, interrupt)
- Queue and route approval requests
- Track context usage and costs

**Does NOT know about:**
- Git, worktrees, or repositories
- UI state or rendering
- Which worktree a session belongs to

### 3. UI (`src/ui/`)

Presentation layer. Subscribes to both managers, renders state, handles user input.

**Responsibilities:**
- Render three-column layout
- Display conversation messages
- Show approval prompts
- Display file changes
- Handle tabs (Claude, diff, image views)
- Keyboard shortcuts
- User input

**Orchestrates the worktree ↔ session association:**
- Maintains mapping: `worktreeId → sessionId`
- When user switches worktree → switch to associated session (or create one)
- When user clicks file → open diff tab
- When user approves → send decision to Claude Manager

**Worktree ↔ Session Binding (UI State):**

```typescript
// UI maintains this mapping
interface WorktreeBinding {
    worktreeId: string;
    sessionId: string | null;    // null = no active session
}

// When creating a session, UI passes worktree.path as cwd
const session = await claudeManager.createSession({ cwd: worktree.path });
bindings.set(worktree.id, session.id);
```

The managers stay decoupled. UI is the glue.

---

## Module Interfaces

### Claude Manager

```typescript
// src/claude-manager/types.ts

export interface ClaudeManagerConfig {
    cliPath?: string;           // Path to claude binary, default: 'claude'
    defaultModel?: string;      // Default model to use
}

export interface CreateSessionOptions {
    cwd: string;                // Working directory
    sessionId?: string;         // Resume existing session
    forkSession?: boolean;      // Fork from sessionId
    permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
}

export interface Session {
    id: string;
    cwd: string;
    status: 'starting' | 'idle' | 'running' | 'awaiting_approval' | 'error' | 'stopped';
    model?: string;
    contextUsage?: { used: number; max: number };
    costUsd?: number;
}

export interface PendingApproval {
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId?: string;
    queuePosition: number;      // 1-indexed, for "1/3" display
    queueTotal: number;
}

// Events emitted by ClaudeManager
export type ClaudeEvent =
    | { type: 'session_started'; session: Session }
    | { type: 'session_stopped'; sessionId: string; reason: 'completed' | 'interrupted' | 'error' }
    | { type: 'message'; sessionId: string; message: AssistantMessage | UserMessage }
    | { type: 'stream_delta'; sessionId: string; delta: StreamDelta }
    | { type: 'tool_use'; sessionId: string; toolUse: ToolUse }
    | { type: 'tool_result'; sessionId: string; toolResult: ToolResult }
    | { type: 'approval_requested'; approval: PendingApproval }
    | { type: 'approval_resolved'; sessionId: string; requestId: string }
    | { type: 'usage_updated'; sessionId: string; usage: UsageStats }
    | { type: 'error'; sessionId: string; error: string };

export interface ClaudeManager {
    // Lifecycle
    createSession(options: CreateSessionOptions): Promise<Session>;
    stopSession(sessionId: string): Promise<void>;
    getSession(sessionId: string): Session | undefined;
    listSessions(): Session[];

    // Messaging
    sendMessage(sessionId: string, content: string): void;
    interrupt(sessionId: string): void;

    // Approvals
    getPendingApprovals(sessionId: string): PendingApproval[];
    respondToApproval(sessionId: string, requestId: string, allow: boolean, message?: string): void;

    // Events
    on(event: 'event', handler: (event: ClaudeEvent) => void): void;
    off(event: 'event', handler: (event: ClaudeEvent) => void): void;
}
```

### Workspace Manager

```typescript
// src/workspace-manager/types.ts

export interface Workspace {
    id: string;
    path: string;               // Path to main repository
    name: string;               // Display name (basename)
    worktrees: Worktree[];
}

export interface Worktree {
    id: string;
    path: string;               // Path to worktree directory
    branch: string;             // Current branch name
    isMainWorktree: boolean;    // Is this the main repo, not a linked worktree
    lastModified: Date;         // Last file modification time
}

export interface FileChange {
    path: string;               // Relative to worktree root
    absolutePath: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
    staged: boolean;
    insertions?: number;
    deletions?: number;
    oldPath?: string;           // For renames
}

export interface FileDiff {
    path: string;
    hunks: DiffHunk[];
}

export interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffLine[];
}

export interface DiffLine {
    type: 'context' | 'add' | 'delete';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
}

// Events emitted by WorkspaceManager
export type WorkspaceEvent =
    | { type: 'workspace_added'; workspace: Workspace }
    | { type: 'workspace_removed'; workspaceId: string }
    | { type: 'worktree_added'; workspaceId: string; worktree: Worktree }
    | { type: 'worktree_removed'; workspaceId: string; worktreeId: string }
    | { type: 'files_changed'; worktreeId: string; changes: FileChange[] }
    | { type: 'branch_changed'; worktreeId: string; branch: string }
    | { type: 'error'; worktreeId?: string; error: string };

export interface WorkspaceManager {
    // Workspace management
    addWorkspace(repoPath: string): Promise<Workspace>;
    removeWorkspace(workspaceId: string): void;
    listWorkspaces(): Workspace[];
    getWorkspace(workspaceId: string): Workspace | undefined;

    // Worktree management
    createWorktree(workspaceId: string, branch: string, baseBranch?: string): Promise<Worktree>;
    deleteWorktree(worktreeId: string): Promise<void>;
    getWorktree(worktreeId: string): Worktree | undefined;

    // File operations
    getFileChanges(worktreeId: string): FileChange[];
    getFileDiff(worktreeId: string, filePath: string, staged: boolean): Promise<FileDiff>;
    stageFile(worktreeId: string, filePath: string): Promise<void>;
    unstageFile(worktreeId: string, filePath: string): Promise<void>;
    stageAll(worktreeId: string): Promise<void>;
    unstageAll(worktreeId: string): Promise<void>;
    discardFile(worktreeId: string, filePath: string): Promise<void>;
    discardAll(worktreeId: string): Promise<void>;

    // Commits
    commit(worktreeId: string, message: string): Promise<string>;  // Returns commit hash

    // Events
    on(event: 'event', handler: (event: WorkspaceEvent) => void): void;
    off(event: 'event', handler: (event: WorkspaceEvent) => void): void;
}
```

---

## Event Flow Examples

### User sends a message

```
User types "Fix the bug" → presses Enter
    │
    ▼
UI calls claudeManager.sendMessage(sessionId, "Fix the bug")
    │
    ▼
ClaudeManager writes to CLI stdin
    │
    ▼
CLI streams response on stdout
    │
    ▼
ClaudeManager parses NDJSON, emits events:
    - { type: 'stream_delta', delta: { text: "I'll" } }
    - { type: 'stream_delta', delta: { text: " look" } }
    - { type: 'stream_delta', delta: { text: " into" } }
    - ...
    - { type: 'message', message: { role: 'assistant', content: [...] } }
    │
    ▼
UI receives events, updates conversation view
```

### Claude edits a file

```
Claude executes Edit tool → file changes on disk
    │
    ├──────────────────────────────────┐
    ▼                                  ▼
ClaudeManager emits:              WorkspaceManager's fs watcher triggers
{ type: 'tool_result', ... }           │
    │                                  ▼
    │                             WorkspaceManager emits:
    │                             { type: 'files_changed', changes: [...] }
    │                                  │
    ▼                                  ▼
UI updates conversation           UI updates file list
```

### Approval flow

```
Claude wants to run Bash command
    │
    ▼
ClaudeManager receives can_use_tool request from CLI
    │
    ▼
ClaudeManager emits:
{ type: 'approval_requested', approval: { toolName: 'Bash', ... } }
    │
    ▼
UI shows approval prompt at bottom of conversation
    │
    ▼
User clicks [Allow]
    │
    ▼
UI calls claudeManager.respondToApproval(sessionId, requestId, true)
    │
    ▼
ClaudeManager sends control_response to CLI stdin
    │
    ▼
ClaudeManager emits:
{ type: 'approval_resolved', requestId: '...' }
    │
    ▼
UI removes approval prompt
```

---

## Directory Structure

```
claude-ui/
├── docs/
│   ├── architecture.md              # This file
│   ├── claude-code-cli-reference.md # CLI protocol reference
│   ├── claude-executor-implementation-guide.md
│   └── ui-design-spec.md            # UI design
│
├── src/
│   ├── claude-manager/
│   │   ├── index.ts                 # Exports ClaudeManager
│   │   ├── types.ts                 # TypeScript interfaces
│   │   ├── session.ts               # Session class (manages one CLI process)
│   │   ├── protocol.ts              # NDJSON parsing, message types
│   │   └── approval-queue.ts        # Approval request handling
│   │
│   ├── workspace-manager/
│   │   ├── index.ts                 # Exports WorkspaceManager
│   │   ├── types.ts                 # TypeScript interfaces
│   │   ├── workspace.ts             # Workspace class
│   │   ├── worktree.ts              # Worktree class
│   │   ├── git.ts                   # Git command wrappers
│   │   ├── diff.ts                  # Diff parsing
│   │   └── watcher.ts               # Filesystem watcher
│   │
│   ├── ui/
│   │   ├── index.ts                 # App entry point
│   │   ├── app.tsx                  # Root component
│   │   ├── components/
│   │   │   ├── workspaces/          # Left column
│   │   │   ├── view-pane/           # Middle column (tabs, claude, diff)
│   │   │   ├── file-changes/        # Right column
│   │   │   └── status-bar/
│   │   ├── hooks/
│   │   │   ├── useClaudeManager.ts
│   │   │   └── useWorkspaceManager.ts
│   │   └── styles/
│   │       └── variables.css        # CSS custom properties
│   │
│   └── main.ts                      # Electron/Tauri main process
│
├── package.json
└── tsconfig.json
```

---

## Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Language | TypeScript | Type safety, ecosystem |
| Backend | Hono + Node.js | Lightweight, WebSocket support, fast |
| Frontend | React + Vite | Fast dev, familiar, good ecosystem |
| Styling | CSS Modules + CSS Variables | Scoped, themeable |
| State management | Zustand | Simple, works well with events |
| Git operations | simple-git | Promise-based git wrapper |
| FS watching | chokidar | Cross-platform, reliable |
| Process management | child_process (Node) | Spawn Claude CLI |
| WebSocket | hono/ws + ws | Streaming events to frontend |
| Desktop runtime | TBD (Electron or Tauri) | Package later, dev in browser for now |

---

## Technical Architecture

### Runtime Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                             │
│                   (localhost:5173)                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    React Frontend                      │  │
│  │              (Vite dev server in dev)                  │  │
│  └────────────────────────┬──────────────────────────────┘  │
└────────────────────────────┼────────────────────────────────┘
                             │ WebSocket ws://localhost:9900/ws
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Hono Server (Node.js)                    │
│                      localhost:9900                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              WebSocket Handler (/ws)                   │  │
│  └───────────┬───────────────────────────────┬───────────┘  │
│              │                               │              │
│  ┌───────────▼───────────┐   ┌───────────────▼───────────┐  │
│  │    Claude Manager     │   │   Workspace Manager       │  │
│  └───────────┬───────────┘   └───────────────┬───────────┘  │
│              │                               │              │
│              ▼                               ▼              │
│      ┌───────────────┐               ┌───────────────┐      │
│      │  Claude CLI   │               │  Git / FS     │      │
│      └───────────────┘               └───────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### WebSocket Protocol

Single WebSocket connection, multiplexed JSON messages:

```typescript
// Client → Server
type ClientMessage =
  // Session
  | { type: 'session:create'; requestId: string; worktreePath: string }
  | { type: 'session:stop'; sessionId: string }
  | { type: 'session:send'; sessionId: string; content: string }
  | { type: 'session:interrupt'; sessionId: string }
  | { type: 'session:approve'; sessionId: string; requestId: string; allow: boolean }

  // Workspace
  | { type: 'workspace:add'; requestId: string; path: string }
  | { type: 'workspace:remove'; workspaceId: string }
  | { type: 'worktree:create'; requestId: string; workspaceId: string; branch: string }
  | { type: 'file:stage'; worktreeId: string; path: string }
  | { type: 'file:unstage'; worktreeId: string; path: string }
  | { type: 'file:diff'; requestId: string; worktreeId: string; path: string; staged: boolean }
  | { type: 'commit:create'; requestId: string; worktreeId: string; message: string }

// Server → Client
type ServerMessage =
  // Session events
  | { type: 'session:created'; requestId: string; session: Session }
  | { type: 'session:stopped'; sessionId: string; reason: string }
  | { type: 'session:message'; sessionId: string; message: Message }
  | { type: 'session:delta'; sessionId: string; delta: StreamDelta }
  | { type: 'session:approval'; approval: PendingApproval }
  | { type: 'session:approval:resolved'; sessionId: string; requestId: string }
  | { type: 'session:usage'; sessionId: string; usage: Usage }
  | { type: 'session:error'; sessionId: string; error: string }

  // Workspace events
  | { type: 'workspace:added'; requestId: string; workspace: Workspace }
  | { type: 'worktree:added'; requestId: string; worktree: Worktree }
  | { type: 'files:changed'; worktreeId: string; files: FileChange[] }
  | { type: 'diff:result'; requestId: string; diff: FileDiff }
  | { type: 'commit:created'; requestId: string; hash: string }
  | { type: 'error'; requestId?: string; error: string }
```

### Project Structure

```
claude-ui/
├── docs/
│
├── packages/
│   ├── server/                  # Hono backend
│   │   ├── src/
│   │   │   ├── index.ts         # Entry: creates Hono app, starts server
│   │   │   ├── ws.ts            # WebSocket handler
│   │   │   ├── claude-manager/
│   │   │   │   ├── index.ts     # ClaudeManager class
│   │   │   │   ├── session.ts   # Session class (one CLI process)
│   │   │   │   ├── protocol.ts  # NDJSON parsing
│   │   │   │   └── types.ts
│   │   │   └── workspace-manager/
│   │   │       ├── index.ts     # WorkspaceManager class
│   │   │       ├── workspace.ts # Workspace class
│   │   │       ├── git.ts       # Git operations
│   │   │       ├── watcher.ts   # FS watcher
│   │   │       └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                     # React frontend
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── Workspaces/
│       │   │   ├── ViewPane/
│       │   │   ├── FileChanges/
│       │   │   └── StatusBar/
│       │   ├── hooks/
│       │   │   ├── useSocket.ts
│       │   │   └── useStore.ts
│       │   ├── store/
│       │   │   └── index.ts     # Zustand store
│       │   └── styles/
│       │       └── variables.css
│       ├── index.html
│       ├── package.json
│       └── vite.config.ts
│
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
└── tsconfig.base.json           # Shared TS config
```

### Dev Workflow

```bash
# Terminal 1: Backend
cd packages/server && pnpm dev   # tsx watch, port 9900

# Terminal 2: Frontend
cd packages/web && pnpm dev      # vite, port 5173
```

Or with a root script:
```bash
pnpm dev  # runs both via turbo or concurrently
```

---

## Principles

1. **Modules don't import each other** - ClaudeManager and WorkspaceManager are independent
2. **Events, not callbacks** - Managers emit events, UI subscribes
3. **UI orchestrates** - Business logic for "switch worktree = switch session" lives in UI
4. **Interfaces first** - Define types before implementation
5. **Single binary** - Ship one thing, modules are internal
