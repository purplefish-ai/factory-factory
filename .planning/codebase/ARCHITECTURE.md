# Architecture

**Analysis Date:** 2026-02-10

## Pattern Overview

**Overall:** Full-stack Express + tRPC + React monorepo with clear backend/frontend separation and domain-driven service layer.

**Key Characteristics:**
- **tRPC API Layer**: Backend exposes typed procedures via tRPC (Express adapter), consumed by React frontend via `@trpc/react-query`
- **Service-Oriented Backend**: Business logic centralized in `src/backend/services/` (85+ services), accessed by tRPC routers
- **Resource Accessors**: Database layer abstraction in `src/backend/resource_accessors/` (11 accessors) wrapping Prisma
- **Stateful Session Management**: Claude SDK session lifecycle managed by `src/backend/services/session.service.ts` with process registry
- **Domain Layers**: Emerging domain pattern with `src/backend/domains/session/` for complex domain logic
- **SQLite + Prisma**: Local-first database with migrations, schema-driven types

## Layers

**API/RPC Layer:**
- Purpose: Expose backend functionality to frontend via typed RPC procedures
- Location: `src/backend/trpc/`
- Contains: Routers (workspace, session, project, admin, github, etc.), public procedures, context setup
- Depends on: Services, resource accessors, Zod schemas
- Used by: Frontend React components via `src/frontend/lib/trpc.ts`

**Service Layer:**
- Purpose: Implement business logic, coordination, and side effects
- Location: `src/backend/services/`
- Contains: 85+ domain services (session, workspace, github, ratchet, run-script, terminal, etc.)
- Depends on: Resource accessors, Prisma, Claude SDK, external services (GitHub CLI, Node APIs)
- Used by: tRPC routers, other services, lifecycle managers

**Resource Access Layer:**
- Purpose: Encapsulate all Prisma database queries
- Location: `src/backend/resource_accessors/`
- Contains: Workspace, project, session, decision-log, terminal-session, user-settings accessors
- Depends on: Prisma, typed schemas
- Used by: Services

**Frontend UI Layer:**
- Purpose: Render React components, manage user interactions
- Location: `src/client/` (routes), `src/frontend/components/` (reusable components), `src/components/` (shadcn/ui)
- Contains: Route pages, feature components, shared components, hooks
- Depends on: tRPC client, React Router, Zustand (state), React hooks
- Used by: Browser/Electron renderer

**Data Layer:**
- Purpose: SQLite database with Prisma ORM
- Location: `prisma/schema.prisma`, managed via `src/backend/db.ts`
- Contains: Models (Workspace, ClaudeSession, TerminalSession, Project, DecisionLog, etc.)
- Depends on: Better SQLite3 adapter
- Used by: Resource accessors (only access point)

**Claude Integration Layer:**
- Purpose: Manage Claude SDK process lifecycle, message protocol, permissions
- Location: `src/backend/claude/`
- Contains: Session manager, protocol handler, permissions system, process registry, monitoring
- Depends on: Node.js child_process, Anthropic SDK
- Used by: Session service, session domain service

## Data Flow

**Workspace Creation Flow:**

1. User submits form in `src/client/routes/projects/workspaces/new.tsx`
2. Frontend calls `trpc.workspace.create()` via `src/frontend/lib/trpc.ts` (tRPC client)
3. tRPC request hits `src/backend/trpc/workspace.trpc.ts::create` procedure
4. Procedure calls `WorkspaceCreationService.createWorkspace()`
5. Service calls `workspaceAccessor.create()` to persist to database
6. Accessor uses Prisma to insert `Workspace` model
7. Service returns created workspace, triggers initialization via `worktreeLifecycleService`
8. Frontend receives typed response, updates React state via `@trpc/react-query`

**Session Lifecycle Flow:**

1. User clicks "Start Session" in workspace detail
2. Frontend calls `trpc.session.create()` → `src/backend/trpc/session.trpc.ts`
3. tRPC procedure calls `sessionService.createSession()`
4. Service instantiates `SessionManager` from `src/backend/claude/session.ts`
5. SessionManager spawns Claude subprocess via `claudeClient.run()` and registers in `ProcessRegistry`
6. Session state persisted via `sessionDomainService` and `claudeSessionAccessor`
7. WebSocket established for real-time message streaming (chat, terminal output)
8. Session messages forwarded via `chatEventForwarderService` to client

**PR Ratchet Monitoring Flow:**

1. Scheduler triggers `ratchetService.checkAllPRs()` periodically
2. Service queries workspaces with `ratchetEnabled=true`
3. For each workspace, calls GitHub CLI via `githubCLIService` to fetch PR status
4. Updates workspace cached fields: `prState`, `prCiStatus`, `ratchetState` via `workspaceAccessor.update()`
5. When CI fails, `ratchetService` creates auto-fix session via `fixerSessionService`
6. Session runs claude agent to address failures
7. Kanban state derived in real-time from ratchet state (not stored, computed)

**State Management:**
- **Database Source of Truth**: All durable state in SQLite (Workspace, ClaudeSession, etc.)
- **Cached Computed Fields**: `cachedKanbanColumn`, `stateComputedAt` optimize list queries
- **In-Memory Session State**: Claude subprocess lifecycle tracked in memory (ProcessRegistry, SessionManager)
- **Frontend State**: React Query caches tRPC responses, Zustand for local UI state
- **Real-time Updates**: WebSocket events from backend push changes to frontend (chat, terminal, status)

## Key Abstractions

**Workspace:**
- Purpose: Represents a unit of work tied to a git branch, PR, and optionally GitHub issue
- Files: `src/backend/resource_accessors/workspace.accessor.ts`, `src/backend/services/workspace-*.service.ts`
- State: NEW → PROVISIONING → READY (or FAILED, ARCHIVED)
- Tracks: Branch, PR, ratchet state, run script status, session count
- Pattern: State machine with derived computed state (kanban column)

**ClaudeSession:**
- Purpose: Represents a Claude SDK session (interactive agent run)
- Files: `src/backend/services/session.service.ts`, `src/backend/domains/session/`, `src/backend/claude/session.ts`
- Lifecycle: IDLE → RUNNING → PAUSED → COMPLETED (or FAILED)
- Tracks: Workflow type (explore, implement, test), messages, resources, status
- Pattern: Process manager spawns subprocess, lifecycle managed by SessionManager

**Resource Accessor Pattern:**
- Purpose: Single point of Prisma access, all queries go through accessors
- Examples: `workspaceAccessor`, `claudeSessionAccessor`, `projectAccessor`
- Pattern: Methods return typed Prisma payloads, include relations as needed
- Benefit: Easy to trace data flow, refactor queries in one place

**Service Pattern:**
- Purpose: Stateless business logic orchestration
- Examples: `ratchetService`, `sessionService`, `workspaceCreationService`
- Pattern: Export singleton instance, methods are async or sync pure functions
- Uses: Resource accessors, other services, external clients (GitHub CLI, Claude SDK)

**tRPC Router Pattern:**
- Purpose: Define typed RPC endpoints
- Files: `src/backend/trpc/*.trpc.ts`
- Pattern: `publicProcedure` (no auth currently) with Zod input validation, handlers call services
- Scoping: Optional headers `X-Project-Id`, `X-Top-Level-Task-Id` set in context for access control

## Entry Points

**CLI Entrypoint:**
- Location: `src/cli/index.ts`
- Triggers: `pnpm dev`, `pnpm start` commands
- Responsibilities:
  - Parse CLI args (project config, database path, port)
  - Spawn backend server and frontend Vite dev server
  - Manage child process lifecycle (SIGTERM, SIGINT, failures)
  - Open browser to frontend
  - Serve combined app on single port

**Backend Server Entrypoint:**
- Location: `src/backend/index.ts` (standalone), `src/backend/server.ts::createServer()` (library)
- Triggers: Direct node execution or import by Electron
- Responsibilities:
  - Create AppContext with all services
  - Initialize Express app and HTTP server
  - Setup middleware (CORS, security, logging)
  - Register tRPC routes at `/api/trpc`
  - Register REST routes (health, project, MCP)
  - Setup WebSocket upgrade handlers (chat, terminal, dev-logs)
  - Start listening, handle graceful shutdown

**Frontend Entrypoint:**
- Location: `src/client/main.tsx`
- Triggers: Vite build/dev, bundled in production
- Responsibilities:
  - Mount React app to `#root` element
  - Setup React Router with routes defined in `src/client/router.tsx`
  - Initialize tRPC client via `src/frontend/lib/providers.tsx`
  - Render root layout and child routes

**Electron Entrypoint:**
- Location: `electron/main/index.ts` (if present, based on agent notes)
- Triggers: `pnpm dev:electron`
- Responsibilities:
  - Import `createServer` from backend
  - Spawn backend server on dynamic port
  - Create Electron main window with renderer
  - Bridge IPC for cross-process communication

## Error Handling

**Strategy:** Centralized logging, typed error responses via tRPC, user-facing error boundaries

**Patterns:**
- **Logger Service**: All errors logged via `createLogger()` from `src/backend/services/logger.service.ts`
  - Structured logging with level (info, warn, error)
  - Session-specific logs written to `~/.factory-factory/logs/sessions/[sessionId].log`
- **tRPC Error Propagation**: Services throw errors, tRPC catches and returns typed error to frontend
  - Input validation via Zod, returns 400 Bad Request
  - Business logic errors return 500 with message
  - Frontend error boundary in `src/client/error-boundary.tsx` catches render errors
- **Process Error Handling**: Unhandled promise rejections logged, process graceful shutdown attempted
  - `src/backend/index.ts` registers `uncaughtException` and `unhandledRejection` handlers

## Cross-Cutting Concerns

**Logging:**
- Centralized service: `src/backend/services/logger.service.ts`
- Creates contextual loggers with namespace (e.g., 'workspace-trpc', 'session-service')
- Session-specific logs written to file + console based on NODE_ENV
- Frontend logs via browser console (no file aggregation)

**Validation:**
- Input validation: Zod schemas on all tRPC procedures (required)
- Database validation: Prisma schema constraints (unique, not null)
- No raw typecasts; prefer typed Prisma payloads

**Authentication:**
- Currently: No auth implemented (all endpoints public)
- Scoping: Optional headers for project/task context
- Future: Would be middleware on tRPC context

**Configuration:**
- Environment-driven: `DATABASE_PATH`, `BACKEND_PORT`, `FRONTEND_STATIC_PATH`, `NODE_ENV`
- Config service: `src/backend/services/config.service.ts` reads and caches system config
- Workspace-level config: `factory-factory.json` in repo (run script, startup script)
- User settings: Stored in database (workspace order, notification settings, auto-fix toggles)

---

*Architecture analysis: 2026-02-10*
