# Architecture

**Analysis Date:** 2026-02-09

## Pattern Overview

**Overall:** Full-stack monolithic application with layered backend architecture, separate client UI, and CLI interface. Backend uses Express + tRPC server with WebSocket support. Frontend is React 19 with React Router. Database is SQLite (Prisma ORM).

**Key Characteristics:**
- Three-tier backend: routers (tRPC) → services → resource accessors → database
- Strict layer boundaries enforced: tRPC routers cannot call accessors directly
- Express HTTP server with WebSocket upgrade handlers for real-time communication
- React client with tRPC hooks for server communication
- Command-line interface for standalone operation
- Electron wrapper for desktop application

## Layers

**tRPC Routers (API Layer):**
- Purpose: Define RPC endpoints exposed to frontend; handle request validation and orchestration
- Location: `src/backend/trpc/`
- Contains: `*.trpc.ts` files defining router procedures (queries, mutations, subscriptions)
- Depends on: Services, AppContext
- Used by: Frontend via tRPC client hooks, CLI
- Key routers: `workspace.trpc.ts`, `session.trpc.ts`, `project.trpc.ts`, `admin.trpc.ts`, `github.trpc.ts`, `pr-review.trpc.ts`, `user-settings.trpc.ts`, `decision-log.trpc.ts`

**Services (Business Logic Layer):**
- Purpose: Encapsulate domain logic, coordinate across multiple accessors, manage state machines and orchestration
- Location: `src/backend/services/`
- Contains: Service classes implementing business rules (workspace creation, session management, Git operations, scheduling)
- Depends on: Resource accessors, other services, database client
- Used by: tRPC routers, other services
- Examples: `workspace-creation.service.ts`, `session.service.ts`, `git-ops.service.ts`, `ratchet.service.ts`, `terminal.service.ts`, `workspace-state-machine.service.ts`

**Resource Accessors (Data Access Layer):**
- Purpose: Provide type-safe database queries and mutations for specific entities
- Location: `src/backend/resource_accessors/`
- Contains: Accessor classes with methods for CRUD operations on Prisma models
- Depends on: Database (Prisma), types
- Used by: Services only (routers cannot bypass services to use accessors)
- Examples: `workspace.accessor.ts`, `claude-session.accessor.ts`, `project.accessor.ts`, `terminal-session.accessor.ts`, `decision-log.accessor.ts`, `user-settings.accessor.ts`

**Database (Persistence Layer):**
- Purpose: SQLite database with Prisma ORM
- Location: `src/backend/db.ts`, `prisma/schema.prisma`
- Contains: Prisma client, schema definitions, migrations
- Key models: `Workspace`, `Project`, `ClaudeSession`, `DecisionLog`, `UserSettings`, `TerminalSession`

**WebSocket Handlers (Real-Time Communication):**
- Purpose: Handle WebSocket upgrade and message routing for real-time features
- Location: `src/backend/routers/websocket/`
- Contains: Chat handler, terminal handler, dev logs handler
- Depends on: Services, message utilities
- Entry point: HTTP upgrade handler in server.ts

**Express Middleware:**
- Purpose: Cross-cutting concerns for all requests
- Location: `src/backend/middleware/`
- Contains: CORS, request logging, security middleware
- Mounted in: `src/backend/server.ts`

**Domains (Optional Layer - Session Only):**
- Purpose: Encapsulate domain-specific logic with single-writer boundaries
- Location: `src/backend/domains/session/`
- Current use: Session storage with write-serialization (only one session operation at a time per workspace)
- Implementation: `sessionDomainService` re-exports `sessionStoreService`

**Client UI Layer:**
- Purpose: React components for user interface
- Location: `src/client/`, `src/components/`, `src/frontend/`
- Contains: Pages, route definitions, layout components
- Depends on: tRPC hooks, React Query, shared UI components
- Key structure: `src/client/router.tsx` defines routes; `src/client/routes/` contains page components

**Shared Code:**
- Purpose: Code used by both backend and frontend
- Location: `src/shared/`, `src/lib/`, `src/hooks/`, `src/types/`
- Contains: Schemas (Zod), type definitions, utility functions, WebSocket message types
- Examples: `workspace-sidebar-status.ts`, `ci-status.ts`, `pending-request-types.ts`, `websocket/` message definitions

**CLI:**
- Purpose: Command-line interface for standalone operation
- Location: `src/cli/`
- Entry point: `src/cli/index.ts`
- Uses: Server creation and lifecycle functions

## Data Flow

**Session Start Flow:**

1. Frontend calls `session.start` tRPC mutation
2. Mutation routes to `sessionRouter.start` procedure in `src/backend/trpc/session.trpc.ts`
3. Procedure calls `sessionService.startClaudeSession()`
4. Service calls `sessionRepository.getSessionById()` to verify session exists
5. Service calls `sessionService.getOrCreateClient()` which invokes Claude process via `sessionProcessManager`
6. Client created, initial prompt sent
7. Chat handler (WebSocket) listens for session events and forwards to frontend

**Workspace Creation Flow:**

1. Frontend calls `workspace.create` tRPC mutation
2. Router validates input with Zod schema (discriminated union for creation source)
3. Router calls `WorkspaceCreationService.createWorkspace()`
4. Service:
   - Creates workspace record via `workspaceAccessor.create()`
   - Transitions to PROVISIONING state via `workspaceStateMachine`
   - Runs startup script via `startupScriptService`
   - Creates worktree via `worktreeLifecycleService`
   - Transitions to READY state on success, FAILED on error
5. Frontend polls `workspace.get` to monitor status or listens via real-time state derivation

**Real-Time Updates:**

1. Server maintains WebSocket connections from client
2. Chat messages flow: Client → WebSocket → chatHandler → sessionService → Claude process → event → forward to all connected clients
3. Terminal output: CLI/spawned process → terminalService → terminalHandler → WebSocket → frontend
4. Kanban state: Services update workspace state in database → frontend queries refreshed data or watches via listeners

## Key Abstractions

**Workspace State Machine:**
- Purpose: Enforce valid workspace status transitions
- Implementation: `workspaceStateMachine` service in `src/backend/services/workspace-state-machine.service.ts`
- States: `NEW` → `PROVISIONING` → `READY` (or `FAILED`)
- Controls: Workspace initialization lifecycle

**Session Manager:**
- Purpose: Unified lifecycle management for Claude processes
- Implementation: `SessionManager` class in `src/backend/claude/session.ts`
- Handles: Client creation with race protection, message sending, graceful shutdown
- Used by: `sessionService` which wraps it

**Ratchet (Auto-Fix):**
- Purpose: Automatically watch and fix failing pull requests
- Implementation: `ratchetService` in `src/backend/services/ratchet.service.ts`
- States: `IDLE`, `CI_RUNNING`, `CI_FAILED`, `REVIEW_PENDING`, `READY`, `MERGED`
- Triggers: CI failures, review comments, merge readiness checks

**Kanban State:**
- Purpose: Derive workspace column (WORKING, WAITING, DONE) from internal state
- Implementation: Derived from workspace status and session status, not stored
- Used by: UI for board view

**Run Script:**
- Purpose: Execute and manage workspace startup/runtime scripts
- Implementation: `RunScriptService`, `runScriptStateMachine` in `src/backend/services/`
- States: `IDLE`, `STARTING`, `RUNNING`, `STOPPING`, `COMPLETED`, `FAILED`

## Entry Points

**Backend HTTP Server:**
- Location: `src/backend/server.ts` exports `createServer()`
- Triggers: Called by CLI (`src/cli/index.ts`) or Electron main process
- Responsibilities: Create Express app, mount middleware/routers, handle WebSocket upgrades, start HTTP server
- Returns: `ServerInstance` with `start()`, `stop()`, `getPort()`, `getHttpServer()` methods

**CLI:**
- Location: `src/cli/index.ts` (executable via `ff` or `factory-factory` command)
- Triggers: User runs `ff serve` or `ff serve --dev`
- Responsibilities: Parse command-line arguments, set up environment, call `createServer()`, manage lifecycle

**Frontend Entry:**
- Location: `src/client/main.tsx` and `src/client/router.tsx`
- Triggers: Browser page load
- Responsibilities: Mount React app, set up providers (TRPC, Theme, Query), render router

**WebSocket Upgrade:**
- Location: HTTP upgrade handler in `src/backend/server.ts`
- Triggers: Client WebSocket connection attempt to `/ws/chat`, `/ws/terminal`, `/ws/dev-logs`
- Responsibilities: Authenticate connection, create upgrade handler, route to appropriate handler

## Error Handling

**Strategy:** Layered error handling with type-safe validation and graceful degradation

**Patterns:**

- **Validation:** Zod schemas in routers validate all inputs before service calls
- **Error Propagation:** Services throw `Error` (caught by tRPC, converted to JSON-RPC error responses)
- **Async Error Handling:** Process-level handlers (`uncaughtException`, `unhandledRejection`) log and attempt graceful shutdown
- **Database Errors:** Prisma errors bubble up, handled by routers which return error responses
- **WebSocket Errors:** Handled per connection; failed connections terminate and clients reconnect
- **State Machine Errors:** Invalid state transitions throw, caught by caller

Example error flow:
```typescript
// Router catches service error
try {
  await workspaceCreationService.createWorkspace(input);
} catch (error) {
  // tRPC converts to { code: 'INTERNAL_SERVER_ERROR', message: '...' }
  throw error;
}

// Frontend receives error, displays toast/UI feedback
```

## Cross-Cutting Concerns

**Logging:**
- Framework: Custom logger service (`src/backend/services/logger.service.ts`) with named loggers
- Pattern: Each module creates logger via `createLogger('module-name')`
- Output: Logs to console in dev, structured in production

**Validation:**
- Framework: Zod schemas throughout
- Pattern: Define schema → parse with input → throw on validation failure
- Location: Schemas in routers and services

**Authentication:**
- Not implemented for local-first desktop app
- Public procedures (no auth middleware)
- CLI uses local WebSocket connection

**Rate Limiting:**
- Service: `rateLimiter` in AppContext
- Purpose: Prevent abuse of expensive operations
- Implementation: Token bucket or similar pattern

**WebSocket Message Serialization:**
- Framework: SuperJSON transformer for tRPC
- Handles: Date, Map, Set, Error serialization across network

**Database Transactions:**
- Pattern: Explicit `$transaction()` calls in services for multi-step operations
- Example: Workspace creation wraps creation + state machine transition

