# Architecture

**Analysis Date:** 2026-02-01

## Pattern Overview

**Overall:** Multi-layered workspace-based platform with real-time Claude Code CLI integration via WebSocket protocol.

**Key Characteristics:**
- Service-oriented architecture with tRPC RPC framework for client-server communication
- Multi-transport layer: tRPC (REST/HTTP), WebSocket (chat/terminal streaming), Express middleware chain
- Event-driven patterns with message queuing and deferred/permission-based task execution
- Database-first design with git worktree isolation per workspace
- Bridge pattern for Claude CLI process lifecycle management (ClaudeClient → AgentProcessAdapter)

## Layers

**Presentation Layer (Frontend):**
- Purpose: React UI for project/workspace management, chat interface, terminal sessions
- Location: `src/client/`, `src/components/`, `src/frontend/`
- Contains: React Router v7 routes, page components, UI components (Radix primitives), hooks
- Depends on: tRPC query client, React Query, WebSocket hooks (`useWebSocketTransport`)
- Used by: End users in browser or Electron desktop app

**Application Server Layer (Backend):**
- Purpose: Express.js HTTP server with tRPC RPC handlers, WebSocket upgrade handlers
- Location: `src/backend/server.ts`, `src/backend/index.ts`
- Contains: HTTP routing, middleware chain (CORS, rate limiting, security), tRPC router mounting, static file serving
- Depends on: Express, tRPC adapter, WebSocket server, resource accessors, services
- Used by: Frontend clients, CLI WebSocket connections

**API Layer (tRPC Routers):**
- Purpose: Type-safe RPC procedures for CRUD operations on projects, workspaces, sessions
- Location: `src/backend/trpc/`
- Contains: Router definitions (`project.trpc.ts`, `workspace.trpc.ts`, `session.trpc.ts`, etc.), context creation, procedure helpers
- Depends on: Resource accessors, services, business logic
- Used by: Frontend via tRPC client, backend via direct router calls

**WebSocket Handler Layer:**
- Purpose: Manage real-time streaming connections for chat, terminal, dev logs
- Location: `src/backend/routers/websocket/`
- Contains: Chat handler (`chat.handler.ts`), terminal handler, dev logs handler
- Depends on: Message services, session management, Claude client lifecycle
- Used by: Frontend WebSocket clients, CLI connections

**Business Logic / Service Layer:**
- Purpose: Encapsulate domain logic, state management, external integrations
- Location: `src/backend/services/`
- Contains: 35+ services covering: session management, chat/message handling, workspace state machine, file logging, MCP tool execution, reconciliation, scheduling
- Key services:
  - `session.service.ts`: ClaudeClient lifecycle, session options
  - `chat-connection.service.ts`: WebSocket connection tracking
  - `chat-message-handlers.service.ts`: Message dispatch by type
  - `workspace-state-machine.service.ts`: Workspace status transitions (NEW → PROVISIONING → READY)
  - `message-state.service.ts`: In-flight message tracking
  - `event-compression.service.ts`: Delta compression for WebSocket replay
- Depends on: Database accessors, Claude client, MCP server, external clients (Git, GitHub)
- Used by: Routers, WebSocket handlers, agents

**Data Access Layer (Resource Accessors):**
- Purpose: Abstract database queries via Prisma ORM, single point for entity access
- Location: `src/backend/resource_accessors/`
- Contains: Accessors for Project, Workspace, ClaudeSession, TerminalSession, DecisionLog, UserSettings
- Depends on: Prisma client
- Used by: Services, tRPC procedures

**Claude Integration Layer:**
- Purpose: Bridge with Claude CLI process, handle streaming protocol, manage permissions/hooks
- Location: `src/backend/claude/`
- Contains:
  - `ClaudeClient`: High-level API for streaming JSON protocol
  - `ClaudeProcess`: Process lifecycle management
  - `SessionManager`: Session history/resumption
  - `PermissionHandler`: Permission modes (autoApprove, deferred, plan-based)
  - Protocol parsing, types, control messages
- Depends on: Node child_process, WebSocket for event forwarding
- Used by: Session service, chat message handlers, agent process adapter

**MCP (Model Context Protocol) Layer:**
- Purpose: Execute tools requested by Claude CLI (filesystem, git, terminal, system)
- Location: `src/backend/routers/mcp/`
- Contains: MCP server initialization, tool definitions (system, terminal, git, lock operations)
- Depends on: Shell execution, git operations, process management
- Used by: Claude CLI via stdio, agent process adapter for tool interception

**Agent Process Adapter:**
- Purpose: Unified interface for agent lifecycle and tool execution
- Location: `src/backend/agents/process-adapter.ts`
- Contains: Agent start/stop, message event forwarding, tool execution delegation
- Depends on: ClaudeClient, MCP server, event emitter pattern
- Used by: Future agent orchestration features

**Database Layer:**
- Purpose: SQLite persistence for projects, workspaces, sessions, logs
- Location: `src/backend/db.ts`, `prisma/schema.prisma`
- Contains: Prisma client singleton, schema definitions
- Depends on: better-sqlite3 adapter, Prisma migrations
- Used by: All resource accessors

**CLI Entry Point:**
- Purpose: Server startup, process orchestration, port management
- Location: `src/cli/index.ts`
- Contains: Commander.js command parsing, database migrations, process lifecycle, dev/prod mode handling
- Depends on: Backend server creation, database setup
- Used by: Node process, npm scripts

## Data Flow

**Interactive Chat Session (Web UI):**

1. User sends message via React component → tRPC call (or WebSocket to chat handler)
2. Frontend passes `projectId` + `taskId` context via headers
3. tRPC procedure or WebSocket handler validates context, creates/gets ClaudeClient
4. ClaudeClient spawns/resumes Claude CLI process
5. Message sent via stdin streaming JSON protocol
6. Claude CLI responds with stream events (text chunks, tool uses, control requests)
7. ClaudeProcess emits events → ChatEventForwarderService sets up listeners
8. Chat handlers dispatch messages by type (text, tool_use, permission_request, etc.)
9. Tool use requests → MCP server execution → MCP tool response → Claude via tool_result
10. Final result/exit → SessionManager persists session to `~/.claude/projects/`
11. WebSocket sends completion to frontend → React Query updates UI

**Workspace Provisioning (Initialization):**

1. User creates workspace via ProjectPage → tRPC procedure creates Workspace record (status: NEW)
2. Async provisioning triggered via services
3. WorkspaceStateMachine: NEW → PROVISIONING
4. Git worktree created at `worktreePath`
5. Startup script executed (if configured) with timeout + port allocation
6. On success: READY with `runScriptPid`, `runScriptPort`
7. On failure: FAILED with `initErrorMessage`
8. Frontend polls workspace status or receives updates via WebSocket

**Terminal Session (PTY):**

1. WebSocket upgrade on `/api/terminal/:id`
2. TerminalService spawns PTY for workspace
3. Terminal input received → written to PTY stdin
4. PTY output → sent back via WebSocket frames
5. On close: PTY killed, dev log file finalized

**State Reconciliation:**

1. ReconciliationService runs on schedule
2. Compares database state vs actual filesystem/process state
3. Updates mismatched workspace statuses (e.g., runScript exited but status still RUNNING)
4. Recovers from crashes/orphaned processes

## Key Abstractions

**ClaudeClient:**
- Purpose: Unified abstraction over Claude CLI process lifecycle and streaming protocol
- Examples: `src/backend/claude/index.ts`
- Pattern: Wraps ClaudeProcess + SessionManager + PermissionHandler, emits typed events (text, tool_use, etc.)

**Resource Accessor:**
- Purpose: Single source of truth for database queries per entity type
- Examples: `src/backend/resource_accessors/project.accessor.ts`, `workspace.accessor.ts`
- Pattern: Static methods on class, no instance state, delegates to Prisma

**Service Singleton:**
- Purpose: Stateful service instances with initialization, accessible globally via `src/backend/services/index.ts`
- Examples: `sessionService`, `chatConnectionService`, `messageStateService`, `terminalService`
- Pattern: `export const serviceInstance = new ServiceClass(); /* initialize */`

**Message Handler/Dispatcher:**
- Purpose: Route messages by type to appropriate handler function
- Examples: `src/backend/services/chat-message-handlers.service.ts`
- Pattern: Map of message type → handler function, called from WebSocket/tRPC layer

**Event Compression:**
- Purpose: Delta compression for large message histories in WebSocket replay
- Examples: `src/backend/services/event-compression.service.ts`
- Pattern: Compress outgoing events on send, decompress on reconnect

**State Machine:**
- Purpose: Explicit workspace status transitions with side effects
- Examples: `src/backend/services/workspace-state-machine.service.ts`
- Pattern: Current state + event → next state + side effects (create worktree, run script)

## Entry Points

**CLI/Standalone Server:**
- Location: `src/cli/index.ts`
- Triggers: `npm run dev` or `pnpm dev`
- Responsibilities: Argument parsing, database migration, backend server creation, port detection, process lifecycle

**Express Server:**
- Location: `src/backend/server.ts` exported as `createServer()`
- Triggers: Called from `src/backend/index.ts` (CLI mode) or Electron main process
- Responsibilities: Create HTTP server, mount Express middleware, attach WebSocket server, register routers

**Frontend Entry Point:**
- Location: `src/client/main.tsx`
- Triggers: Vite build process
- Responsibilities: DOM mounting, render Root component with providers (tRPC, React Query, Theme)

**Router (Frontend):**
- Location: `src/client/router.tsx` (React Router v7)
- Triggers: Root component render
- Responsibilities: Route configuration, lazy loading, layout nesting

**WebSocket Upgrade Handlers:**
- Location: `src/backend/routers/websocket/`
- Triggers: WebSocket upgrade requests on paths `/api/chat`, `/api/terminal`, `/api/dev-logs`
- Responsibilities: Session validation, client creation, event forwarding, connection tracking

**tRPC Router:**
- Location: `src/backend/trpc/index.ts` (aggregates all routers)
- Triggers: Express middleware mounting
- Responsibilities: Route tRPC calls from frontend to procedure implementations

## Error Handling

**Strategy:** Layered error handling with validation at each layer, error responses through tRPC/WebSocket, logging via createLogger service.

**Patterns:**
- Frontend: Error boundaries catch React errors, tRPC client errors trigger toast notifications
- Backend: tRPC procedures return error objects, WebSocket handlers send error messages, graceful degradation on tool failures
- Database: Prisma errors propagate up through accessors, logged by error middleware
- Process: Uncaught exceptions trigger graceful server shutdown, unhandled rejections logged

## Cross-Cutting Concerns

**Logging:** `src/backend/services/logger.service.ts` creates scoped loggers via `createLogger(scope)` pattern. Frontend uses browser console. Session logs stored via `sessionFileLogger`.

**Validation:** Zod schemas at tRPC procedure boundaries (`src/backend/schemas/`), WebSocket message schemas in `src/backend/schemas/websocket/`.

**Authentication:** None (assumes trusted environment, Claude CLI provides per-session authentication to Anthropic API).

**Permission Control:** PermissionHandler modes (autoApprove, deferred, plan-based) in Claude integration layer control tool execution.

**Database Transactions:** Prisma handle implicit transactions per query, explicit `$transaction()` for multi-step operations in services.

**State Synchronization:** WebSocket real-time updates for chat/terminal, tRPC polling for workspace status, event-driven message queue for decoupled tool responses.

---

*Architecture analysis: 2026-02-01*
