# Architecture

**Analysis Date:** 2026-01-29

## Pattern Overview

**Overall:** Three-tier fullstack architecture with React frontend, Express + tRPC backend, and SQLite database. Supports both web and Electron desktop modes. Real-time bidirectional communication via WebSocket for chat/terminal sessions.

**Key Characteristics:**
- **API Layer:** tRPC with type-safe RPC procedures (no OpenAPI schema needed)
- **Real-time Communication:** WebSocket for Claude Code CLI streaming and terminal sessions
- **Process Management:** Child process spawning for Claude CLI and terminal PTYs
- **Workspace Isolation:** Git worktrees isolate each workspace as independent branches
- **MCP Integration:** Model Context Protocol server for Claude agent tool execution

## Layers

**Frontend (React + Vite):**
- Purpose: Project management UI, workspace dashboard, real-time chat and terminal display
- Location: `src/client/`, `src/components/`
- Contains: Route handlers, layout components, UI primitives, hooks
- Depends on: tRPC client, React Router v7, TanStack Query, WebSocket
- Used by: Browser/Electron renderer process

**Backend (Express + tRPC):**
- Purpose: API server, session management, git operations, process spawning, WebSocket handlers
- Location: `src/backend/`
- Contains: tRPC routers, service layer, resource accessors, interceptors
- Depends on: Prisma ORM, git CLI, node-pty, Claude CLI client
- Used by: Frontend via tRPC, CLI, Electron main process

**Database (SQLite + Prisma):**
- Purpose: Persistent storage for projects, workspaces, sessions, decision logs
- Location: `prisma/schema.prisma`, stored at `~/factory-factory/data.db` (configurable)
- Contains: Project, Workspace, ClaudeSession, TerminalSession, DecisionLog models
- Depends on: Better SQLite3 adapter
- Used by: Backend resource accessors

**CLI (Node.js):**
- Purpose: Standalone command-line interface for serving the app
- Location: `src/cli/index.ts`
- Contains: Commander.js CLI commands, child process orchestration
- Depends on: Express backend, Vite frontend build
- Used by: Manual invocation, Electron app

**Electron Desktop App:**
- Purpose: Native desktop wrapper with OS integration
- Location: `electron/main/`, `electron/preload/`
- Contains: BrowserWindow manager, server lifecycle management
- Depends on: Express backend, compiled frontend
- Used by: Desktop users

## Data Flow

**Project Creation:**
1. User submits form in `src/client/routes/projects/new.tsx`
2. tRPC call to `src/backend/trpc/project.trpc.ts` → `createProject()`
3. Resource accessor `src/backend/resource_accessors/project.accessor.ts` writes to Prisma
4. Database returns created Project record
5. Frontend refetches project list via TanStack Query

**Workspace Creation & Initialization:**
1. User creates workspace in `src/client/routes/projects/workspaces/new.tsx`
2. tRPC call to `src/backend/trpc/workspace.trpc.ts` → `create()`
3. `workspaceAccessor` creates Workspace record with `initStatus: PENDING`
4. `startupScriptService` queues initialization
5. Async startup script runs (creates git worktree, installs deps)
6. Status progresses: `PENDING` → `INITIALIZING` → `READY` or `FAILED`
7. Frontend polls workspace status or receives WebSocket notification

**Claude Session Workflow:**
1. User creates session in workspace detail page
2. tRPC call to `src/backend/trpc/session.trpc.ts` → `createSession()`
3. `sessionService` spawns Claude CLI child process via `agentProcessAdapter`
4. `ClaudeClient` establishes pipe communication with Claude process
5. Frontend opens WebSocket to `/chat` endpoint
6. Backend streams Claude responses through `ClaudeSession` message protocol
7. Terminal session created separately for workspace shell access

**Terminal Session Flow:**
1. WebSocket connects to `/terminal` endpoint
2. `terminalService` creates PTY via `node-pty`
3. Terminal I/O streams bidirectionally through WebSocket
4. Each workspace has independent PTY instance

**Git Workflow with Interceptors:**
1. Workspace git operations call `GitClientFactory.create()`
2. Interceptor registry (`src/backend/interceptors/registry.ts`) wraps execution
3. `pr-detection.interceptor.ts` detects PR creation and updates workspace.prUrl
4. `branch-rename.interceptor.ts` tracks branch renames
5. `githubCLIService` syncs PR status from GitHub
6. Kanban state computed from PR state + CI status

**State Management:**
- **Backend:** Prisma database as source of truth
- **Frontend:** TanStack Query caches, syncs on interval or explicit refetch
- **Real-time:** WebSocket broadcasts for terminal and chat (not automatically for project changes)
- **Context:** ProjectContext provides projectId/taskId to child components via `useProjectContext()`

## Key Abstractions

**Resource Accessor Pattern:**
- Purpose: Centralize all database queries, enforce consistent patterns
- Examples: `src/backend/resource_accessors/workspace.accessor.ts`, `src/backend/resource_accessors/project.accessor.ts`
- Pattern: Static methods, typed inputs/outputs, Prisma queries encapsulated

**Service Layer:**
- Purpose: Business logic, orchestration, external integrations
- Examples: `src/backend/services/session.service.ts`, `src/backend/services/terminal.service.ts`, `src/backend/services/github-cli.service.ts`
- Pattern: Singleton instances created in `src/backend/services/index.ts`, exported globally

**tRPC Router Pattern:**
- Purpose: Type-safe API endpoints with automatic client code generation
- Examples: `src/backend/trpc/workspace.trpc.ts`, `src/backend/trpc/project.trpc.ts`
- Pattern: Public procedures grouped by domain, context injection via headers

**Interceptor Registry:**
- Purpose: Hook into git operations without modifying core client
- Location: `src/backend/interceptors/registry.ts`
- Pattern: Decorators applied to shell commands, execute before/after hooks

**WebSocket Protocol:**
- Purpose: Real-time streaming without polling
- Implementations: `/chat` (Claude streaming), `/terminal` (PTY I/O)
- Pattern: Message dispatch based on connection type, JSON message framing

## Entry Points

**Backend Server:**
- Location: `src/backend/index.ts`
- Triggers: `pnpm dev` or `pnpm start`
- Responsibilities: Express setup, WebSocket server, tRPC middleware, service initialization, cleanup

**Frontend:**
- Location: `src/client/main.tsx`
- Triggers: Vite dev server or production build
- Responsibilities: Root render, provider setup, router initialization

**CLI:**
- Location: `src/cli/index.ts`
- Triggers: `pnpm dev` or direct CLI invocation
- Responsibilities: Command parsing, backend spawning, browser opening, process management

**Electron Main:**
- Location: `electron/main/index.ts`
- Triggers: `pnpm dev:electron` or `electron .`
- Responsibilities: Window creation, backend lifecycle, IPC setup

**Router Configuration:**
- Location: `src/client/router.tsx`
- Triggers: Application load
- Responsibilities: React Router v7 route tree definition, nested layouts

## Error Handling

**Strategy:** Layered validation with Zod schemas at tRPC boundary, try-catch in services, graceful degradation in UI.

**Patterns:**
- **tRPC Procedures:** Input validation with Zod, TRPCError thrown on failures (automatic HTTP serialization)
- **Git Operations:** Shell command failures captured, logged via `createLogger()`, often wrapped in try-catch with fallback
- **Process Management:** Child process errors logged, status tracked in database, UI shows error state
- **Frontend:** Error boundaries (`src/client/error-boundary.tsx`) catch React render errors, fallback UI displayed
- **WebSocket:** Connection errors handled per session, automatic reconnect logic (not visible in codebase shown, likely handled by client)

## Cross-Cutting Concerns

**Logging:**
- Framework: `src/backend/services/logger.service.ts` - wraps console, adds context labels
- Usage: Every service and router imports `createLogger('module-name')` for structured logging

**Validation:**
- Zod schemas in tRPC routers (all inputs validated before hitting procedures)
- Custom validation in services where domain logic applies

**Authentication:**
- Not detected in codebase - appears to be single-user or environment-based
- No JWT/session middleware visible, context headers are informational (projectId, taskId)

**Rate Limiting:**
- Framework: `src/backend/services/rate-limiter.service.ts`
- Integration: Middleware applied in `src/backend/index.ts`

**File Locking:**
- Purpose: Prevent concurrent workspace initialization
- Implementation: `src/backend/services/file-lock.service.ts` with retries

**Scheduling:**
- Framework: `src/backend/services/scheduler.service.ts`
- Use: Queues reconciliation tasks, workspace initialization, periodic PR syncs

---

*Architecture analysis: 2026-01-29*
