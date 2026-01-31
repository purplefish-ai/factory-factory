# Architecture

**Analysis Date:** 2026-01-31

## Pattern Overview

**Overall:** Layered Monolith with Workspace Isolation

**Key Characteristics:**
- Full-stack TypeScript monorepo with shared types
- Express + tRPC backend with WebSocket real-time communication
- React Router v7 SPA frontend with tRPC client
- SQLite (Prisma ORM) for persistence
- Electron wrapper for desktop distribution
- Git worktrees for workspace isolation

## Layers

**Frontend (React SPA):**
- Purpose: User interface for workspace management and Claude Code chat
- Location: `src/client/` (routes), `src/components/` (shared components), `src/frontend/` (app-specific components)
- Contains: React components, hooks, route definitions
- Depends on: tRPC client, WebSocket connections
- Used by: Browser/Electron renderer

**Backend API (Express + tRPC):**
- Purpose: REST/tRPC API endpoints for CRUD operations
- Location: `src/backend/trpc/`, `src/backend/routers/api/`
- Contains: tRPC routers, Express route handlers
- Depends on: Resource accessors, services
- Used by: Frontend via tRPC client

**WebSocket Handlers:**
- Purpose: Real-time bidirectional communication
- Location: `src/backend/routers/websocket/`
- Contains: Chat handler (Claude CLI), terminal handler (PTY), dev-logs handler
- Depends on: Claude client, terminal service, session service
- Used by: Frontend WebSocket connections

**Resource Accessors (Repository Layer):**
- Purpose: Database access abstraction
- Location: `src/backend/resource_accessors/`
- Contains: Type-safe Prisma query wrappers
- Depends on: Prisma client
- Used by: tRPC routers, services

**Services Layer:**
- Purpose: Business logic and cross-cutting concerns
- Location: `src/backend/services/`
- Contains: Session management, terminal service, scheduler, reconciliation
- Depends on: Resource accessors, external systems
- Used by: Routers, handlers

**Claude Integration:**
- Purpose: Interface with Claude Code CLI subprocess
- Location: `src/backend/claude/`
- Contains: ClaudeClient, SessionManager, protocol parsing
- Depends on: Node.js child_process, session files
- Used by: Chat WebSocket handler

**Interceptors:**
- Purpose: Tool event observation and side effects
- Location: `src/backend/interceptors/`
- Contains: PR detection, branch rename, conversation rename
- Depends on: Tool events from Claude client
- Used by: Chat handler

**Electron Shell:**
- Purpose: Desktop app wrapper, backend lifecycle management
- Location: `electron/`
- Contains: Main process, preload scripts, server manager
- Depends on: Backend server module
- Used by: Desktop distribution

## Data Flow

**User Sends Chat Message:**

1. User types in ChatInput component (`src/components/chat/chat-input.tsx`)
2. Message queued via `messageQueueService` with settings (model, thinking, etc.)
3. Queue dispatches when Claude is idle
4. Chat WebSocket handler (`src/backend/routers/websocket/chat.handler.ts`) receives message
5. `sessionService` creates/reuses ClaudeClient subprocess
6. ClaudeClient sends message to Claude Code CLI via stdin JSON protocol
7. ClaudeClient emits stream events as Claude responds
8. Chat handler forwards events to all connected WebSocket clients
9. Frontend `useChatWebSocket` hook updates React state
10. VirtualizedMessageList renders new messages

**Workspace Creation:**

1. User submits form in NewWorkspacePage (`src/client/routes/projects/workspaces/new.tsx`)
2. tRPC mutation `workspace.create` called
3. Backend creates Workspace record with status `NEW`
4. Async initialization: GitClient creates worktree, runs startup script
5. Status updated to `PROVISIONING` -> `READY` (or `FAILED`)
6. Frontend polls or receives real-time updates

**State Management:**
- Server state: Prisma/SQLite for persistence
- Runtime state: In-memory services (sessionService, terminalService)
- Client state: React Query cache (via tRPC) + local React state
- Real-time sync: WebSocket events update client state

## Key Abstractions

**Workspace:**
- Purpose: Isolated development environment with git worktree
- Examples: `src/backend/resource_accessors/workspace.accessor.ts`, `src/backend/trpc/workspace.trpc.ts`
- Pattern: Has status lifecycle (NEW -> PROVISIONING -> READY/FAILED -> ARCHIVED)

**ClaudeSession:**
- Purpose: Chat session with Claude Code CLI
- Examples: `src/backend/resource_accessors/claude-session.accessor.ts`, `src/backend/claude/session.ts`
- Pattern: Maps to Claude CLI session file (~/.claude/projects/...)

**ClaudeClient:**
- Purpose: Wrapper around Claude Code CLI subprocess
- Examples: `src/backend/clients/` (referenced), `src/backend/services/session.service.ts`
- Pattern: EventEmitter for stream events, request/response for interactive tools

**Project:**
- Purpose: Repository configuration and workspace container
- Examples: `src/backend/resource_accessors/project.accessor.ts`, `src/backend/trpc/project.trpc.ts`
- Pattern: One project per git repository

**ToolInterceptor:**
- Purpose: React to Claude tool executions
- Examples: `src/backend/interceptors/pr-detection.interceptor.ts`, `src/backend/interceptors/branch-rename.interceptor.ts`
- Pattern: Observer pattern - registered at startup, notified on tool events

## Entry Points

**CLI (Web Mode):**
- Location: `src/cli/index.ts`
- Triggers: `ff serve`, `pnpm dev`, `pnpm start`
- Responsibilities: Start backend, run migrations, optionally start Vite dev server

**Backend Server:**
- Location: `src/backend/index.ts` (entry), `src/backend/server.ts` (implementation)
- Triggers: CLI serve command, Electron server manager
- Responsibilities: Express app setup, WebSocket server, tRPC mounting

**Frontend SPA:**
- Location: `src/client/main.tsx` (entry), `src/client/router.tsx` (routes)
- Triggers: Browser load, Electron window load
- Responsibilities: React app rendering, routing

**Electron Main:**
- Location: `electron/main/index.ts`
- Triggers: Electron app launch
- Responsibilities: Window creation, backend lifecycle via ServerManager

## Error Handling

**Strategy:** Layered with graceful degradation

**Patterns:**
- tRPC errors bubble to frontend with type-safe error codes
- WebSocket errors sent as JSON messages with `type: 'error'`
- Claude client errors forwarded to connected clients
- Uncaught exceptions logged, process stays alive
- Graceful shutdown on SIGTERM/SIGINT with timeout

## Cross-Cutting Concerns

**Logging:**
- Custom `createLogger()` in `src/backend/services/logger.service.ts`
- Structured logging with context objects
- Session file logging for WebSocket debugging

**Validation:**
- Zod schemas in tRPC procedures
- URL/path validation in WebSocket handlers

**Authentication:**
- None (single-user desktop app assumption)
- WorkingDir validation constrains paths to worktree base

**Configuration:**
- Environment variables read at startup
- `configService` centralizes config access
- `factory-factory.json` per-project config support

---

*Architecture analysis: 2026-01-31*
