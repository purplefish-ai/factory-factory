# Architecture

**Analysis Date:** 2026-02-01

## Pattern Overview

**Overall:** Workspace-based client-server architecture with layered separation of concerns. Backend provides REST/tRPC APIs and WebSocket channels for real-time communication. Frontend is a React SPA with explicit routing.

**Key Characteristics:**
- Full-stack TypeScript with shared types
- tRPC for strongly-typed RPC between client and server
- WebSocket channels for real-time chat, terminal, and logging
- SQLite database with Prisma ORM
- Express backend with middleware pipeline
- React Router v7 frontend with explicit route configuration

## Layers

**CLI Entry Point:**
- Purpose: Bootstrap the application, manage services startup, handle database migrations
- Location: `src/cli/index.ts`
- Contains: Commander.js CLI commands (serve, build, db:migrate)
- Depends on: Backend server (via src/backend/index.ts), services
- Used by: npm scripts (dev, start, build)

**Backend Server:**
- Purpose: Core HTTP/WebSocket server, orchestrates all backend services
- Location: `src/backend/server.ts`
- Contains: Express app setup, middleware registration, router mounting, WebSocket handlers, graceful shutdown
- Depends on: tRPC routers, middleware, services, database
- Used by: CLI, Electron main process

**tRPC API Layer:**
- Purpose: Strongly-typed RPC procedures for CRUD operations on domain objects
- Location: `src/backend/trpc/`
- Contains: Router definitions (project.trpc.ts, workspace.trpc.ts, session.trpc.ts, admin.trpc.ts, etc.)
- Depends on: Resource accessors, services, procedures
- Used by: Frontend via @trpc/react-query client

**Resource Accessors:**
- Purpose: Data access layer - all database queries go through these
- Location: `src/backend/resource_accessors/`
- Contains: Accessor classes (project.accessor.ts, workspace.accessor.ts, session.accessor.ts, etc.)
- Depends on: Prisma client, types
- Used by: tRPC routers, services

**Services Layer:**
- Purpose: Business logic, orchestration, stateful management
- Location: `src/backend/services/`
- Contains: ~34 services including chat management, terminal sessions, file locking, scheduling, reconciliation
- Examples: `session.service.ts`, `terminal.service.ts`, `scheduler.service.ts`, `chat-message-handlers.service.ts`
- Depends on: Resource accessors, database, utilities
- Used by: tRPC routers, server lifecycle

**WebSocket Handlers:**
- Purpose: Real-time communication endpoints
- Location: `src/backend/routers/websocket/`
- Contains: Chat upgrade handler, terminal upgrade handler, dev logs upgrade handler
- Depends on: Services, WebSocket, protocols
- Used by: Server upgrade events

**API Routers:**
- Purpose: RESTful API endpoints outside tRPC
- Location: `src/backend/routers/api/`
- Contains: Health check, MCP router, Project operations
- Depends on: Services, resource accessors
- Used by: Express middleware stack

**Frontend Client:**
- Purpose: React SPA for workspace management and AI interaction
- Location: `src/client/`
- Contains: Router configuration, root layout, error boundary
- Depends on: Routes, components, hooks, tRPC client
- Used by: Browser via Vite dev server or static build

**Frontend Routes:**
- Purpose: Page-level route components
- Location: `src/client/routes/`
- Contains: Home, Projects list/create, Workspaces list/create/detail, Reviews, Admin
- Depends on: Components, layouts, hooks, tRPC client
- Used by: React Router configuration in src/client/router.tsx

**Components:**
- Purpose: Reusable UI pieces for frontend
- Location: `src/components/`
- Organized by feature: `chat/`, `workspace/`, `agent-activity/`, `ui/` (Radix UI primitives)
- Contains: Chat reducer, persistence, input handling, message rendering
- Examples: `chat-reducer.ts` (69KB chat state machine), `chat-input.tsx`, `permission-prompt.tsx`
- Used by: Routes and other components

**Claude Integration:**
- Purpose: Protocol parsing, session management, permissions for Claude Code CLI
- Location: `src/backend/claude/`
- Contains: Protocol parser, session manager, permissions, types
- Examples: `protocol.ts`, `session.ts`, `permissions.ts`, `process.ts`
- Depends on: Services, types
- Used by: WebSocket handlers for chat

**Database:**
- Purpose: Data persistence
- Location: `prisma/` (schema) + `src/backend/db.ts` (client initialization)
- Technology: SQLite via better-sqlite3 adapter
- Path: `~/factory-factory/data.db` (configurable via DATABASE_PATH env)
- Accessed by: All resource accessors via singleton Prisma client

## Data Flow

**Workspace Creation Flow:**

1. User submits form in `NewWorkspacePage` (`src/client/routes/projects/workspaces/new.tsx`)
2. tRPC call via `trpc.workspace.create.useMutation()` from `@trpc/react-query`
3. Request → Express → tRPC middleware → `workspace.trpc.ts` create procedure
4. Procedure calls `workspaceAccessor.create()` in `src/backend/resource_accessors/workspace.accessor.ts`
5. Accessor queries database via Prisma
6. Response returned to client, React Query updates cache
7. Frontend re-renders workspace detail page

**Chat Session Flow:**

1. User starts chat in workspace detail view
2. WebSocket connection established to `/chat` endpoint
3. Server upgrade handler (`handleChatUpgrade` in `src/backend/routers/websocket/index.ts`)
4. Chat session created, Claude protocol parser initialized
5. User messages forwarded to Claude API
6. Responses streamed back via WebSocket in JSON protocol format
7. Frontend `chat-reducer.ts` processes messages, updates Redux-like state
8. Persistence service saves chat to IndexedDB (client-side)

**State Management:**

**Frontend State:**
- Chat: Reducer-based (src/components/chat/chat-reducer.ts) with persistence to IndexedDB
- Routing: React Router URL-driven
- Data fetching: tRPC + React Query

**Backend State:**
- Session state machine: `workspace-state-machine.service.ts`
- Terminal sessions: Tracked in `terminal.service.ts`
- File locks: Managed by `file-lock.service.ts`
- Scheduling: Handled by `scheduler.service.ts`

## Key Abstractions

**Workspace:**
- Purpose: Isolated git worktree for Claude Code CLI sessions
- Location: `prisma/schema.prisma` (Workspace model) + `src/backend/resource_accessors/workspace.accessor.ts`
- Stateful: ACTIVE, COMPLETED, ARCHIVED states managed by `workspace-state-machine.service.ts`
- Accessed: tRPC `workspace.*` procedures

**ClaudeSession:**
- Purpose: Chat session with Claude Code CLI
- Location: `prisma/schema.prisma` (ClaudeSession model) + `src/backend/resource_accessors/claude-session.accessor.ts`
- Lifecycle: Created, resumed, closed
- WebSocket: Session-specific channel at `/chat?sessionId=...`

**TerminalSession:**
- Purpose: PTY terminal spawned within a workspace
- Location: `prisma/schema.prisma` (TerminalSession model) + `src/backend/services/terminal.service.ts`
- Lifecycle: Spawned on demand, persisted across reconnects via file system
- WebSocket: Session-specific channel at `/terminal?sessionId=...`

**Project:**
- Purpose: Git repository configuration, workspace container
- Location: `prisma/schema.prisma` (Project model) + `src/backend/resource_accessors/project.accessor.ts`
- Contains: Repo path, default branch, GitHub info
- Accessed: tRPC `project.*` procedures

## Entry Points

**CLI (Development/Production):**
- Location: `src/cli/index.ts`
- Triggers: `pnpm dev`, `pnpm start`, or `ff serve` command
- Responsibilities:
  - Parse command-line arguments
  - Ensure database directory exists
  - Run Prisma migrations
  - Spawn backend server (tsx in dev, node in prod)
  - Spawn Vite frontend (dev mode only)
  - Open browser
  - Handle graceful shutdown

**Electron Main Process:**
- Location: `electron/main.ts` (inferred from build script)
- Triggers: `pnpm dev:electron` or app launch
- Responsibilities:
  - Create BrowserWindow
  - Spawn backend server as child process
  - Load frontend from Vite dev server or static build
  - Manage IPC with renderer process

**Server Startup:**
- Location: `src/backend/index.ts`
- Creates: ServerInstance via `createServer()` from `src/backend/server.ts`
- Registers: Instance globally via `serverInstanceService`
- Handles: SIGTERM, SIGINT, uncaught exceptions for graceful shutdown

**Frontend Bootstrap:**
- Location: `src/client/main.tsx`
- Creates: React root with StrictMode
- Loads: Router from `src/client/router.tsx`
- Mounts: to #root element in HTML

## Error Handling

**Strategy:** Layered error propagation with context-aware handling

**Backend Patterns:**
- tRPC procedures throw typed errors caught by middleware
- Services throw with descriptive messages logged via logger service
- WebSocket errors broadcast to client as JSON messages
- Database errors caught by resource accessors, logged with context
- HTTP errors formatted with development/production response bodies (see server.ts error handler)

**Frontend Patterns:**
- tRPC useQuery/useMutation hooks expose error in state
- ErrorBoundary component at root level catches React render errors
- Chat reducer handles malformed protocol messages gracefully
- WebSocket reconnection with exponential backoff (websocket-config.ts)

**Logging:** Centralized logger service (`src/backend/services/logger.service.ts`) with namespaced logging

## Cross-Cutting Concerns

**Logging:**
- Backend: `src/backend/services/logger.service.ts` with createLogger() factory
- Namespaced by component (logger('server'), logger('workspace'), etc.)
- Session file logger: `src/backend/services/session-file-logger.service.ts` for workspace transcripts

**Validation:**
- Backend: Zod schemas in tRPC procedure inputs
- Frontend: React Hook Form with Zod validation

**Authentication:**
- Context: tRPC context extracts X-Project-Id and X-Top-Level-Task-Id headers
- Permissions: Claude protocol layer checks in `src/backend/claude/permissions.ts`
- No traditional user auth (workspace-scoped via headers)

**Rate Limiting:**
- Service: `src/backend/services/rate-limiter.service.ts` for API limits
- Chat: Message queue service prevents flooding

**Database Transactions:**
- Managed by Prisma client within resource accessors
- Used in workspace creation, session management

---

*Architecture analysis: 2026-02-01*
