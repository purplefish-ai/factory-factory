# Architecture

**Analysis Date:** 2026-02-09

## Pattern Overview

**Overall:** Client-server architecture with event-driven real-time communication

**Key Characteristics:**
- Express.js backend with tRPC RPC framework
- React SPA frontend with React Router
- WebSocket-based real-time communication for chat, terminal, and dev logs
- Service-oriented backend with domain services and resource accessors
- Prisma SQLite database with migration-based schema management
- Electron wrapper for desktop distribution

## Layers

**Presentation Layer:**
- Purpose: User interface and user interactions
- Location: `src/client/` and `src/components/`
- Contains: React components, routes, layouts, hooks
- Depends on: Frontend utilities, TRPC hooks, tRPC client
- Used by: Browser/Electron runtime

**Frontend State & Data Layer:**
- Purpose: Client-side state management, data fetching, caching
- Location: `src/frontend/lib/providers.tsx`, `src/frontend/hooks/`
- Contains: TRPC provider setup, React Query integration, custom hooks
- Depends on: TRPC, React Query
- Used by: Client routes and components

**API Layer (RPC/HTTP):**
- Purpose: RESTful endpoints and tRPC procedures
- Location: `src/backend/routers/api/` (health, mcp, project routers)
- Contains: Express routers for health checks, MCP integration, project management
- Depends on: Express, services
- Used by: Frontend HTTP requests, external clients

**WebSocket Layer:**
- Purpose: Real-time bidirectional communication channels
- Location: `src/backend/routers/websocket/` with handlers for chat, terminal, dev-logs
- Contains: Chat upgrade handler, terminal handler, dev-logs handler
- Depends on: WebSocket server, services, Claude client
- Used by: Frontend WebSocket clients

**Business Logic Layer (Services & Domains):**
- Purpose: Core application logic, state management, business rules
- Location: `src/backend/services/`, `src/backend/domains/`
- Contains: Session management, workspace lifecycle, Git operations, GitHub integration, Kanban state, ratchet (auto-fix) logic
- Depends on: Database (Prisma), external APIs (GitHub, Claude), utilities
- Used by: TRPC procedures, WebSocket handlers, interceptors

**Service Categories:**
- **Session Management:** `sessionService`, `sessionDataService`, `sessionFileLogger`
- **Workspace Lifecycle:** `WorkspaceCreationService`, `workspaceStateMachine`, `worktreeLifecycleService`
- **Chat & AI:** `chatEventForwarderService`, `chatMessageHandlerService`, `chatConnectionService`
- **Terminal:** `terminalService`
- **Git & GitHub:** `github-cli.service`, `gitOpsService`
- **Auto-Fix (Ratchet):** `ratchetService`, `ciFixerService`
- **Scheduled Tasks:** `schedulerService`
- **Configuration:** `configService`, `factory-config.service`

**Data Access Layer:**
- Purpose: Database abstraction and resource access
- Location: `src/backend/resource_accessors/`
- Contains: Workspace accessor, Claude session accessor, project accessor, user settings accessor, decision log accessor
- Depends on: Prisma client, services
- Used by: Services and TRPC procedures

**Database Layer:**
- Purpose: Persistent data storage
- Location: `prisma/` with SQLite database
- Contains: Schema definitions, migrations, generated Prisma client
- Depends on: Better-sqlite3 driver
- Used by: All data access code via Prisma

**Infrastructure Layer:**
- Purpose: Cross-cutting concerns, configuration, utilities
- Location: `src/backend/middleware/`, `src/backend/interceptors/`, `src/backend/constants/`, `src/backend/utils/`
- Contains: CORS, request logging, security middleware; branch rename, conversation rename, PR detection interceptors; runtime constants; utility helpers
- Depends on: Express, services, utilities
- Used by: Server setup, tRPC procedures

## Data Flow

**User Interaction → Frontend Rendering:**

1. User interacts with React component in `src/client/routes/`
2. Component uses TRPC hooks (from `@trpc/react-query`) to call backend procedure
3. TRPC client sends HTTP POST to `/trpc/*` endpoint
4. Response is cached by React Query and triggers re-render
5. UI displays updated data

**Real-Time Chat Session:**

1. Frontend initiates WebSocket connection to `/chat` endpoint via `src/components/chat/`
2. `createChatUpgradeHandler` in `src/backend/routers/websocket/chat.handler.ts` handles upgrade
3. Chat handler gets or creates Claude client via `sessionService.getOrCreateChatClient()`
4. `chatEventForwarderService` sets up event listeners on Claude client
5. User sends message → forwarded to Claude API via ClaudeClient
6. Claude events (message, thinking, tool use) flow through `ChatEventForwarderService.setupEventListeners()`
7. `chatMessageHandlerService` processes events and routes to appropriate handlers
8. Events forwarded back to WebSocket client as JSON messages
9. Frontend receives and updates UI in real-time

**Workspace Creation & Session Lifecycle:**

1. Frontend calls `workspace.create` tRPC mutation
2. Procedure in `src/backend/trpc/workspace.trpc.ts` validates input with Zod
3. `WorkspaceCreationService` orchestrates: git worktree creation, startup script execution, status transitions
4. `workspaceStateMachine` manages state transitions (NEW → PROVISIONING → READY or FAILED)
5. Status updates stored in database via Prisma
6. Frontend listens for updates via `workspace.subscribe` or polls `workspace.list`
7. User starts session: `session.create` mutation creates Claude session in database
8. Backend creates ClaudeClient, sets up chat/terminal handlers
9. Frontend connects WebSocket for real-time session communication

**Auto-Fix (Ratchet) Flow:**

1. CI Monitor detects PR status changes via GitHub API polling
2. `ratchetService` evaluates PR state (CI_RUNNING, CI_FAILED, REVIEW_PENDING, READY, MERGED)
3. When CI fails: `ciFixerService` creates new fixer session with failure context
4. Fixer session runs Claude with test output and error logs
5. Agent creates commit with fixes
6. `ratchetService` monitors updated CI status
7. Workspace kanban state derived from ratchet state and displayed to user

**State Management:**

- **Database State:** Workspace, session, project data persisted via Prisma SQLite
- **In-Memory State:** Session clients, terminal instances, WebSocket connections in services
- **Derived State:** Kanban columns (WORKING, WAITING, DONE) derived from workspace status and session state via `kanbanStateService`
- **Frontend State:** React Query cache for TRPC data, local React state for UI

## Key Abstractions

**ClaudeClient:**
- Purpose: Interface to Claude API with event-driven architecture
- Examples: `src/backend/claude/index.ts`
- Pattern: EventEmitter-based, events fired for message, thinking, tool-use, text/code output

**Resource Accessor Pattern:**
- Purpose: Encapsulate data access for specific domain entities
- Examples: `src/backend/resource_accessors/workspace.accessor.ts`, `claude-session.accessor.ts`
- Pattern: Static methods grouped by entity type, returns Prisma queries or constructed objects

**tRPC Procedure Pattern:**
- Purpose: Type-safe RPC with input validation, error handling, and context injection
- Examples: `src/backend/trpc/workspace.trpc.ts`, `session.trpc.ts`
- Pattern: `publicProcedure.input(ZodSchema).query/mutation(({ input, ctx }) => ...)`

**Message Handler Pattern:**
- Purpose: Dispatch messages to specialized handler functions
- Examples: `src/backend/services/chat-message-handlers.service.ts`
- Pattern: Registry of handler functions keyed by message type (text_content, tool_use, thinking, etc.)

**State Machine Pattern:**
- Purpose: Enforce valid state transitions for complex workflows
- Examples: `src/backend/services/workspace-state-machine.service.ts`, `run-script-state-machine.service.ts`
- Pattern: Methods like `transition()` validate state and update via event emission

**Interceptor Pattern:**
- Purpose: Observe and modify domain events across services
- Examples: `src/backend/interceptors/` (branch-rename, conversation-rename, pr-detection)
- Pattern: Registry-based, interceptors subscribe to domain events and trigger side effects

**Service Locator Pattern:**
- Purpose: Centralized access to all backend services
- Examples: `src/backend/app-context.ts` creates AppContext with all services
- Pattern: `appContext.services.{serviceName}` provides access throughout backend

## Entry Points

**CLI Entry Point:**
- Location: `src/cli/index.ts`
- Triggers: User runs `ff serve` or `factory-factory serve` command
- Responsibilities: Parse CLI arguments, set environment variables, start backend server

**Backend Server Entry Point:**
- Location: `src/backend/index.ts`
- Triggers: Node.js execution of dist/src/backend/index.js
- Responsibilities: Create app context, initialize server, handle graceful shutdown

**Frontend Entry Point:**
- Location: `src/client/main.tsx`
- Triggers: Vite dev server or bundled frontend in dist/
- Responsibilities: Create React root, render Router component

**Electron Entry Point:**
- Location: `electron/main.ts`
- Triggers: `electron .` command
- Responsibilities: Create BrowserWindow, start backend server as subprocess, manage IPC

**Router Entry Point:**
- Location: `src/client/router.tsx`
- Triggers: Router component renders
- Responsibilities: Define all client routes, load route components

## Error Handling

**Strategy:** Multi-layer error handling with tRPC error propagation and service-level fallbacks

**Patterns:**

- **Input Validation:** Zod schemas on all TRPC inputs validate before procedure execution
- **Logical Errors:** Services throw Error with descriptive messages; TRPC catches and formats as tRPC error
- **WebSocket Errors:** Connection failures trigger reconnect logic; message parse errors logged and skipped
- **Database Errors:** Prisma errors wrapped in try-catch blocks, meaningful messages returned to client
- **Process Errors:** Child processes (git, startup scripts) capture stderr and return error state
- **Graceful Degradation:** Frontend displays error toast via Sonner; session remains usable for retry

## Cross-Cutting Concerns

**Logging:** `src/backend/services/logger.service.ts` provides createLogger() factory; logs written to files via `sessionFileLogger` for sessions; console output for server startup

**Validation:** Zod schemas in `src/backend/schemas/` validate all TRPC inputs, tool inputs, WebSocket messages before processing

**Authentication:** None in current implementation; relies on local filesystem access; future GitHub OAuth integration via `githubCLIService`

**CORS:** Express middleware in `src/backend/middleware/cors.middleware.ts` allows localhost origins for dev, configurable for production

**Rate Limiting:** `rateLimiter` service in `src/backend/services/rate-limiter.service.ts` throttles API calls

**Request Logging:** `requestLoggerMiddleware` logs all HTTP requests with method, path, duration

**Security:** `securityMiddleware` applies security headers (X-Content-Type-Options, X-Frame-Options, etc.)

---

*Architecture analysis: 2026-02-09*
