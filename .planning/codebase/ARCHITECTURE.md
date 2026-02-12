# Architecture

**Analysis Date:** 2026-02-10 (post-SRP refactor)

## Pattern Overview

**Overall:** Full-stack Express + tRPC + React monorepo with clear backend/frontend separation and domain-driven module architecture.

**Key Characteristics:**
- **tRPC API Layer**: Backend exposes typed procedures via tRPC (Express adapter), consumed by React frontend via `@trpc/react-query`
- **Domain Module Architecture**: Business logic organized into 6 domain modules in `src/backend/domains/` (session, workspace, github, ratchet, terminal, run-script)
- **Orchestration Layer**: Cross-domain flows coordinated via `src/backend/orchestration/` with bridge interfaces
- **Infrastructure Services**: ~25 cross-cutting services in `src/backend/services/` (logger, config, scheduler, health, etc.)
- **Resource Accessors**: Database layer abstraction in `src/backend/resource_accessors/` (11 accessors) wrapping Prisma
- **SQLite + Prisma**: Local-first database with migrations, schema-driven types

## Layers

**API/RPC Layer:**
- Purpose: Expose backend functionality to frontend via typed RPC procedures
- Location: `src/backend/trpc/`
- Contains: Routers (workspace, session, project, admin, github, etc.), public procedures, context setup
- Depends on: Domain modules (via barrel imports), resource accessors, Zod schemas
- Used by: Frontend React components via `src/frontend/lib/trpc.ts`

**Domain Module Layer:**
- Purpose: Encapsulate all business logic for a specific domain concept
- Location: `src/backend/domains/{name}/`
- Contains: 6 domain modules, each with services, types, and co-located tests
- Domains: `session` (Claude process lifecycle, chat, event forwarding), `workspace` (creation, state machine, worktree, kanban), `github` (CLI, PR snapshots, review monitoring), `ratchet` (CI monitoring, auto-fix, reconciliation), `terminal` (pty management, output buffering), `run-script` (script execution, startup scripts)
- Pattern: Each domain exports a single public API via `index.ts` barrel file
- Constraint: Domains never import from sibling domains (enforced by dependency-cruiser)

**Orchestration Layer:**
- Purpose: Coordinate cross-domain flows without creating direct domain-to-domain coupling
- Location: `src/backend/orchestration/`
- Contains: `workspace-init.orchestrator.ts`, `workspace-archive.orchestrator.ts`, `domain-bridges.orchestrator.ts`
- Pattern: Orchestrators import from domain barrels; domains use bridge interfaces for cross-domain callbacks
- Used by: tRPC routers, server startup (bridge wiring)

**Infrastructure Service Layer:**
- Purpose: Provide cross-cutting infrastructure capabilities
- Location: `src/backend/services/`
- Contains: ~25 infrastructure services (logger, config, scheduler, port allocation, health, rate limiter, notification, file lock, data backup, etc.)
- Depends on: Configuration, Node.js APIs, external services
- Used by: Domain modules, orchestrators, tRPC routers

**Resource Access Layer:**
- Purpose: Encapsulate all Prisma database queries
- Location: `src/backend/resource_accessors/`
- Contains: Workspace, project, session, decision-log, terminal-session, user-settings accessors
- Depends on: Prisma, typed schemas
- Used by: Domain modules, infrastructure services

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

## Data Flow

**Workspace Creation Flow:**

1. User submits form in `src/client/routes/projects/workspaces/new.tsx`
2. Frontend calls `trpc.workspace.create()` via `src/frontend/lib/trpc.ts` (tRPC client)
3. tRPC request hits `src/backend/trpc/workspace.trpc.ts::create` procedure
4. Procedure calls `WorkspaceCreationService` from `@/backend/domains/workspace`
5. Workspace domain persists workspace via `workspaceAccessor.create()`
6. Orchestrator (`workspace-init.orchestrator.ts`) coordinates worktree setup and optional session creation across domains
7. Frontend receives typed response, updates React state via `@trpc/react-query`

**Session Lifecycle Flow:**

1. User clicks "Start Session" in workspace detail
2. Frontend calls `trpc.session.create()` -> `src/backend/trpc/session.trpc.ts`
3. tRPC procedure calls `sessionService` from `@/backend/domains/session`
4. Session domain instantiates `SessionManager` from `domains/session/claude/`
5. SessionManager spawns Claude subprocess via `claudeClient.run()` and registers in `ProcessRegistry`
6. Session state persisted via `sessionDomainService` and `claudeSessionAccessor`
7. WebSocket established for real-time message streaming (chat, terminal output)
8. Session messages forwarded via `chatEventForwarderService` to client

**PR Ratchet Monitoring Flow:**

1. Scheduler triggers `ratchetService.checkAllPRs()` periodically
2. Ratchet domain queries workspaces with `ratchetEnabled=true`
3. Cross-domain calls to GitHub domain go through bridge interfaces (configured at startup via `domain-bridges.orchestrator.ts`)
4. Updates workspace state through workspace domain bridge
5. When CI fails, ratchet domain creates auto-fix session through session domain bridge
6. Kanban state derived in real-time from ratchet state (not stored, computed)

**State Management:**
- **Database Source of Truth**: All durable state in SQLite (Workspace, ClaudeSession, etc.)
- **Cached Computed Fields**: `cachedKanbanColumn`, `stateComputedAt` optimize list queries
- **In-Memory Session State**: Claude subprocess lifecycle tracked in memory (ProcessRegistry, SessionManager)
- **Frontend State**: React Query caches tRPC responses, Zustand for local UI state
- **Real-time Updates**: WebSocket events from backend push changes to frontend (chat, terminal, status)

## Key Abstractions

**Workspace:**
- Purpose: Represents a unit of work tied to a git branch, PR, and optionally GitHub issue
- Files: `src/backend/domains/workspace/` (creation, state machine, query, worktree lifecycle, kanban state)
- State: NEW -> PROVISIONING -> READY (or FAILED, ARCHIVED)
- Tracks: Branch, PR, ratchet state, run script status, session count
- Pattern: State machine with derived computed state (kanban column)

**ClaudeSession:**
- Purpose: Represents a Claude SDK session (interactive agent run)
- Files: `src/backend/domains/session/` (lifecycle, store, claude process management, chat services)
- Lifecycle: IDLE -> RUNNING -> PAUSED -> COMPLETED (or FAILED)
- Tracks: Workflow type (explore, implement, test), messages, resources, status
- Pattern: Process manager spawns subprocess, lifecycle managed by SessionManager

**Domain Module Pattern:**
- Purpose: Self-contained business logic module with explicit public API
- Structure: `src/backend/domains/{name}/index.ts` barrel, internal services, types, tests
- Constraint: No cross-domain imports; use bridges for callbacks
- Examples: session (largest, includes claude/ subprocess management), workspace (state machine + worktree)

**Resource Accessor Pattern:**
- Purpose: Single point of Prisma access, all queries go through accessors
- Examples: `workspaceAccessor`, `claudeSessionAccessor`, `projectAccessor`
- Pattern: Methods return typed Prisma payloads, include relations as needed
- Benefit: Easy to trace data flow, refactor queries in one place

**Bridge Interface Pattern:**
- Purpose: Allow domains to invoke cross-domain operations without direct imports
- Files: `src/backend/domains/{name}/bridges.ts`, wired in `src/backend/orchestration/domain-bridges.orchestrator.ts`
- Pattern: Domain defines bridge interface -> orchestrator injects implementation at startup -> domain calls bridge at runtime
- Benefit: Domains remain independently testable; cross-domain coupling is explicit and centralized

**tRPC Router Pattern:**
- Purpose: Define typed RPC endpoints
- Files: `src/backend/trpc/*.trpc.ts`
- Pattern: `publicProcedure` (no auth currently) with Zod input validation, handlers call domain services via barrel imports
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
  - Create AppContext with all domain modules and infrastructure services
  - Configure domain bridges via `configureDomainBridges()`
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
- Location: `electron/main/index.ts`
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

*Architecture analysis: 2026-02-10 (updated post-SRP refactor)*
