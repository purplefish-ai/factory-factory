<!-- refreshed: 2026-05-17 -->
# Architecture

**Analysis Date:** 2026-05-17

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                  Runtime Entry Points                        │
├──────────────────┬──────────────────┬───────────────────────┤
│ CLI/standalone   │ React/Vite UI     │ Electron wrapper      │
│ `src/cli/index.ts`│ `src/client/*`   │ `electron/main/*`     │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Express + tRPC + WebSocket                  │
│ `src/backend/server.ts`, `src/backend/trpc/`,                │
│ `src/backend/routers/websocket/`                             │
└────────┬───────────────────────────────┬────────────────────┘
         │                               │
         ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Service Capsules + Orchestration                             │
│ `src/backend/services/{name}/`, `src/backend/orchestration/` │
└────────┬───────────────────────────────┬────────────────────┘
         │                               │
         ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│ SQLite/Prisma + In-memory Runtime State + External CLIs       │
│ `prisma/schema.prisma`, `src/backend/db.ts`, ACP, git, gh     │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI entrypoint | Runs `ff serve`, migrations, production build, proxy mode, and hidden internal ACP adapter command. | `src/cli/index.ts` |
| Backend server | Configures Express middleware, health routes, tRPC, WebSocket upgrades, static SPA serving, startup reconciliation, schedulers, and graceful shutdown. | `src/backend/server.ts` |
| App context | Creates injectable service graph for backend runtime and tests. Use it when code needs cross-cutting services from request context. | `src/backend/app-context.ts` |
| tRPC root router | Composes domain routers into the typed API consumed by the React client. | `src/backend/trpc/index.ts` |
| WebSocket routers | Own chat, terminal, setup terminal, dev log, post-run log, and snapshot streaming upgrade handlers. | `src/backend/routers/websocket/index.ts` |
| Service registry | Declares service capsules, allowed service dependencies, and Prisma model ownership. | `src/backend/services/registry.ts` |
| Service capsules | Own business logic and resource access for one domain behind a public barrel. | `src/backend/services/{name}/index.ts` |
| Orchestration | Coordinates cross-service workflows and bridge wiring without making services import each other. | `src/backend/orchestration/` |
| Snapshot store pipeline | Converts domain events and periodic reconciliation into project-scoped workspace snapshots for UI cache updates. | `src/backend/orchestration/event-collector.orchestrator.ts`, `src/backend/services/workspace-snapshot-store.service.ts` |
| React app | Provides route tree, layout, tRPC provider, WebSocket hooks, and feature views. | `src/client/router.tsx`, `src/client/root.tsx` |
| Shared UI components | Houses shadcn/ui primitives and reusable chat/workspace/project UI. | `src/components/` |
| Shared contracts | Holds cross-runtime enums, schemas, ACP protocol types, websocket schemas, and pure helpers. | `src/shared/`, `src/lib/` |
| Electron shell | Starts the backend in-process for packaged desktop builds and loads the frontend in a secure BrowserWindow. | `electron/main/server-manager.ts`, `electron/main/lifecycle.ts` |
| Prisma schema | Defines persistent domain records and enum state machines. | `prisma/schema.prisma` |

## Pattern Overview

**Overall:** Modular TypeScript monolith with service capsules, orchestration bridges, typed tRPC APIs, and WebSocket streams.

**Key Characteristics:**
- Express hosts both `/api/trpc` and WebSocket upgrade endpoints; in production it also serves the Vite SPA from `dist/client`.
- Backend domains are service capsules under `src/backend/services/{name}/` with `index.ts` as the only public API.
- Cross-service behavior belongs in `src/backend/orchestration/`, which imports service barrels and configures bridge objects.
- Data access is kept in each capsule's `resources/` directory and backed by Prisma models declared in `prisma/schema.prisma`.
- React views consume tRPC through `src/client/lib/trpc.ts` and realtime state through `useWebSocketTransport`.
- Architecture boundaries are enforced by `scripts/check-service-registry.ts` and `.dependency-cruiser.cjs`; both checks pass for this tree.

## Layers

**Runtime Entrypoints:**
- Purpose: Start the app in CLI, standalone backend, dev frontend, proxy, or Electron modes.
- Location: `src/cli/index.ts`, `src/backend/index.ts`, `src/client/main.tsx`, `electron/main/index.ts`
- Contains: command parsing, process spawning, migration startup, backend boot, React root creation, Electron lifecycle setup.
- Depends on: backend server factory, migration runner, Vite, Electron APIs, process environment.
- Used by: npm scripts in `package.json`, published `ff` binary, Electron packaging.

**Transport Layer:**
- Purpose: Expose HTTP and WebSocket interfaces.
- Location: `src/backend/server.ts`, `src/backend/trpc/`, `src/backend/routers/`
- Contains: Express middleware, health routes, tRPC routers, WebSocket upgrade handlers, tRPC context.
- Depends on: `AppContext`, service barrels, orchestration functions, shared schemas.
- Used by: React tRPC client, WebSocket hooks, CLI/Electron runtime.

**Backend Service Capsules:**
- Purpose: Encapsulate domain business logic and persistence access.
- Location: `src/backend/services/{name}/`
- Contains: `index.ts` barrel, optional `service/` logic, optional `resources/` Prisma accessors, co-located tests.
- Depends on: same-capsule internals, declared capsule dependencies via barrels, root infrastructure services where allowed.
- Used by: tRPC routers, WebSocket handlers, orchestration, app context.

**Orchestration Layer:**
- Purpose: Coordinate cross-domain workflows while preserving service boundaries.
- Location: `src/backend/orchestration/`
- Contains: domain bridge configuration, workspace initialization/archive, event collection, snapshot reconciliation, schedulers, health helpers.
- Depends on: service barrels and shared pure helpers.
- Used by: `src/backend/server.ts`, selected tRPC mutations such as workspace create/archive, startup tasks.

**Data Layer:**
- Purpose: Persist projects, workspaces, sessions, settings, decision logs, and periodic tasks.
- Location: `prisma/schema.prisma`, `src/backend/db.ts`, `src/backend/services/*/resources/`
- Contains: Prisma SQLite schema, Prisma client singleton, resource accessors.
- Depends on: `@prisma-gen/client`, `@prisma/adapter-better-sqlite3`, config service.
- Used by: service resources and startup/shutdown cleanup.

**Realtime Runtime State:**
- Purpose: Track long-lived ACP sessions, terminal processes, chat connections, pending requests, snapshot streams, and schedulers.
- Location: `src/backend/services/session/service/`, `src/backend/services/terminal/service/`, `src/backend/services/workspace-snapshot-store.service.ts`, `src/backend/orchestration/`
- Contains: module-level singletons, EventEmitter services, process managers, coalescers, in-memory connection maps.
- Depends on: service capsules, WebSocket handlers, ACP SDK/adapter processes, node-pty.
- Used by: WebSocket transports, tRPC status queries, startup recovery, graceful shutdown.

**Frontend Application Layer:**
- Purpose: Render routes, manage React Query cache, and connect UI controls to API/realtime channels.
- Location: `src/client/`, `src/components/`, `src/hooks/`, `src/lib/`
- Contains: React Router route tree, tRPC provider, shared UI components, chat reducer, WebSocket transport hooks, cache mappers.
- Depends on: shared contracts, `AppRouter` type, React Query, React Router, shadcn/Radix components.
- Used by: Vite development server, production SPA served by backend, Electron BrowserWindow.

**Shared Contract Layer:**
- Purpose: Provide frontend/backend-neutral contracts and pure helpers.
- Location: `src/shared/`, `src/lib/`, `packages/core/src/`
- Contains: enums, ACP protocol schemas, websocket schemas, sidebar/CI helpers, public core package types.
- Depends on: framework-neutral packages only.
- Used by: backend services, frontend UI, package exports.

## Data Flow

### Primary tRPC Request Path

1. React mounts `<TRPCProvider>` and creates a tRPC client for `/api/trpc` (`src/client/lib/providers.tsx:27`, `src/client/lib/trpc.ts:21`).
2. Route or component hooks call typed procedures from `trpc.*` (`src/client/routes/projects/workspaces/use-workspace-detail.ts:24`).
3. Express receives `/api/trpc` and creates request context with `AppContext` plus project/task headers (`src/backend/server.ts:135`, `src/backend/trpc/trpc.ts:23`).
4. `appRouter` dispatches to domain routers such as `workspaceRouter` and `sessionRouter` (`src/backend/trpc/index.ts:15`).
5. Routers validate inputs with Zod and call services/orchestrators (`src/backend/trpc/workspace.trpc.ts:117`, `src/backend/trpc/session.trpc.ts:10`).
6. Service resources read/write Prisma models through accessors (`src/backend/services/workspace/resources/workspace.accessor.ts`, `src/backend/db.ts:48`).
7. Router returns SuperJSON data to React Query (`src/backend/trpc/trpc.ts:36`, `src/client/lib/trpc.ts:26`).

### Workspace Creation and Initialization

1. UI calls `workspace.create` with one of the discriminated creation sources (`src/backend/trpc/workspace.trpc.ts:41`, `src/backend/trpc/workspace.trpc.ts:200`).
2. Router resolves provider health and session capacity, then uses `WorkspaceCreationService` (`src/backend/trpc/workspace.trpc.ts:207`, `src/backend/trpc/workspace.trpc.ts:226`).
3. Router creates the default agent session when enabled (`src/backend/trpc/workspace.trpc.ts:232`).
4. Router starts `initializeWorkspaceWorktree` in the background (`src/backend/trpc/workspace.trpc.ts:257`).
5. Orchestrator moves workspace to provisioning, resolves/creates git worktree, reads `factory-factory.json`, persists run-script commands, creates default terminal, starts default ACP session, runs startup script pipeline, then marks ready or failed (`src/backend/orchestration/workspace-init.orchestrator.ts:1097`).
6. Domain events feed the snapshot pipeline so sidebars, Kanban, and detail headers update without polling (`src/backend/orchestration/event-collector.orchestrator.ts:392`, `src/client/hooks/use-project-snapshot-sync.ts:300`).

### Chat Session WebSocket Flow

1. Chat UI builds `/chat?sessionId=...&connectionId=...` and uses `useWebSocketTransport` (`src/components/chat/use-chat-websocket.ts:143`, `src/hooks/use-websocket-transport.ts:136`).
2. Backend upgrade routing sends `/chat` to `createChatUpgradeHandler` (`src/backend/server.ts:256`).
3. Chat handler validates optional working directory, registers connection, logs session traffic, and delegates message handling (`src/backend/routers/websocket/chat.handler.ts:94`, `src/backend/routers/websocket/chat.handler.ts:211`, `src/backend/routers/websocket/chat.handler.ts:243`).
4. `chatMessageHandlerService` and `sessionService` start/load ACP sessions and dispatch user messages (`src/backend/routers/websocket/chat.handler.ts:84`, `src/backend/services/session/service/`).
5. Session domain events are forwarded to connected clients and to the snapshot event collector (`src/backend/orchestration/domain-bridges.orchestrator.ts:203`, `src/backend/orchestration/event-collector.orchestrator.ts:600`).

### Snapshot Stream Flow

1. Server startup configures domain bridges, event collector, and snapshot reconciliation (`src/backend/server.ts:419`, `src/backend/server.ts:429`).
2. Domain events enqueue snapshot field updates through `EventCoalescer` (`src/backend/orchestration/event-collector.orchestrator.ts:149`, `src/backend/orchestration/event-collector.orchestrator.ts:450`).
3. `workspaceSnapshotStore.upsert` emits `SNAPSHOT_CHANGED` after deriving flow, Kanban, and sidebar fields from configured helpers (`src/backend/orchestration/domain-bridges.orchestrator.ts:408`).
4. `/snapshots` WebSocket sends `snapshot_full`, `snapshot_changed`, and `snapshot_removed` messages scoped by project ID (`src/backend/routers/websocket/snapshots.handler.ts:145`, `src/backend/routers/websocket/snapshots.handler.ts:190`).
5. `useProjectSnapshotSync` maps snapshot entries into React Query caches for sidebar, Kanban, detail, and list fallbacks (`src/client/hooks/use-project-snapshot-sync.ts:177`, `src/client/hooks/use-project-snapshot-sync.ts:214`).
6. Periodic reconciliation recomputes authoritative snapshots from DB/runtime/git every 60 seconds and removes stale store entries (`src/backend/orchestration/snapshot-reconciliation.orchestrator.ts:296`, `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts:364`).

### Electron Runtime Flow

1. Electron main process creates `ServerManager` and lifecycle controller (`electron/main/index.ts:8`).
2. Dev Electron loads `VITE_DEV_SERVER_URL`; production Electron sets database/static/log environment variables before dynamic backend imports (`electron/main/server-manager.ts:33`, `electron/main/server-manager.ts:63`).
3. Production Electron runs migrations, imports `createServer`, starts the backend in-process, and loads the URL into a secure BrowserWindow (`electron/main/server-manager.ts:76`, `electron/main/server-manager.ts:101`, `electron/main/lifecycle.ts:134`).
4. Preload exposes only dialog and focus IPC APIs to the renderer (`electron/preload/index.ts:4`).

**State Management:**
- Persistent state lives in SQLite models from `prisma/schema.prisma`.
- Runtime process state lives in service singletons created by `src/backend/app-context.ts` and cleaned up by `src/backend/server.ts`.
- UI server state lives in React Query caches created by `src/client/lib/providers.tsx`.
- Realtime workspace summary state is normalized through `workspaceSnapshotStore` and synchronized by `/snapshots`.

## Key Abstractions

**Service Capsule:**
- Purpose: Public barrel plus private service/resource internals for a backend domain.
- Examples: `src/backend/services/session/index.ts`, `src/backend/services/workspace/index.ts`, `src/backend/services/periodic-task/index.ts`
- Pattern: Import from `@/backend/services/<name>` outside the capsule; keep `service/` and `resources/` imports internal to the capsule.

**Service Registry:**
- Purpose: Defines capsule names, allowed `dependsOn`, and Prisma model ownership.
- Examples: `src/backend/services/registry.ts`, `scripts/check-service-registry.ts`
- Pattern: Update registry when adding a service capsule or owning a new Prisma model; run `pnpm check:service-registry`.

**AppContext:**
- Purpose: Injectable service graph passed into Express/tRPC/WebSocket handlers.
- Examples: `src/backend/app-context.ts`, `src/backend/server.ts:67`
- Pattern: Read services from `ctx.appContext.services` in tRPC and from handler closure in WebSocket factories.

**Domain Bridges:**
- Purpose: Let services collaborate without direct cyclic imports.
- Examples: `src/backend/orchestration/domain-bridges.orchestrator.ts`, `src/backend/services/*/service/bridges.ts`
- Pattern: Define a capability interface in the service, then wire concrete implementations in orchestration startup.

**tRPC Router:**
- Purpose: Type-safe request/response API between React and backend.
- Examples: `src/backend/trpc/workspace.trpc.ts`, `src/backend/trpc/session.trpc.ts`
- Pattern: Validate inputs with Zod, keep transport logic thin, call service barrels or orchestration functions.

**WebSocket Upgrade Handler:**
- Purpose: Long-lived realtime transports for chat, terminal, logs, and snapshots.
- Examples: `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/snapshots.handler.ts`
- Pattern: Export `create*UpgradeHandler(appContext)`, validate query/input, register connection, delegate business logic to services.

**Resource Accessor:**
- Purpose: Encapsulate Prisma access for service-owned models.
- Examples: `src/backend/services/workspace/resources/workspace.accessor.ts`, `src/backend/services/session/resources/agent-session.accessor.ts`
- Pattern: Keep direct `prisma` imports in resource accessors; use service methods or barrels from higher layers.

**Workspace Snapshot:**
- Purpose: Denormalized realtime workspace state for fast UI updates.
- Examples: `src/backend/services/workspace-snapshot-store.service.ts`, `src/client/lib/snapshot-to-sidebar.ts`, `src/client/lib/snapshot-to-kanban.ts`
- Pattern: Mutate through event collector/reconciliation, stream by project over `/snapshots`, map into cache-specific shapes in client helpers.

## Entry Points

**CLI Binary:**
- Location: `src/cli/index.ts`
- Triggers: `ff`, `factory-factory`, npm scripts.
- Responsibilities: `serve`, `db:migrate`, `db:studio`, `build`, `proxy`, hidden `internal codex-app-server-acp`.

**Standalone Backend:**
- Location: `src/backend/index.ts`
- Triggers: CLI production server, direct node execution, dev backend watcher.
- Responsibilities: Create `AppContext`, create server, register server instance, start server, handle process signals.

**Backend Server Factory:**
- Location: `src/backend/server.ts`
- Triggers: `src/backend/index.ts`, Electron `ServerManager`.
- Responsibilities: Configure Express, tRPC, WebSockets, static files, startup tasks, schedulers, cleanup.

**React App:**
- Location: `src/client/main.tsx`
- Triggers: Vite entry from `index.html`.
- Responsibilities: Mount React StrictMode and router.

**React Router:**
- Location: `src/client/router.tsx`
- Triggers: React root render.
- Responsibilities: Define routes for projects, workspaces, reviews, admin, logs, and mobile baseline.

**Electron Main:**
- Location: `electron/main/index.ts`
- Triggers: Electron process.
- Responsibilities: Register fatal handlers, server lifecycle, IPC handlers, and BrowserWindow lifecycle.

**Prisma Schema:**
- Location: `prisma/schema.prisma`
- Triggers: Prisma generate/migrate, runtime Prisma client.
- Responsibilities: Define SQLite models and enums for projects, workspaces, sessions, settings, periodic tasks, and decision logs.

## Architectural Constraints

- **Threading:** Node.js single event loop with child processes and timers. Backend starts ACP runtimes, terminal ptys, Vite/backend child processes in CLI dev mode, scheduler loops, WebSocket heartbeats, and reconciliation intervals.
- **Global state:** Module-level singletons exist by design in `src/backend/db.ts`, `src/backend/services/session/service/`, `src/backend/services/terminal/service/`, `src/backend/services/workspace-snapshot-store.service.ts`, `src/backend/orchestration/event-collector.orchestrator.ts`, and WebSocket connection maps in `src/backend/routers/websocket/*.handler.ts`.
- **Circular imports:** Disallowed by `.dependency-cruiser.cjs`; `pnpm deps:check` reports no dependency violations.
- **Service dependencies:** Service-to-service imports must target barrels and match `dependsOn` in `src/backend/services/registry.ts`; `pnpm check:service-registry` passes.
- **Frontend/backend boundary:** UI code may import backend tRPC types only through `src/client/lib/trpc.ts`; dependency-cruiser blocks direct frontend imports from `src/backend/`.
- **Database access:** Direct `src/backend/db.ts` imports are limited to service resources, `src/backend/server.ts`, tests, and the DB module itself.
- **Orchestration imports:** Orchestration may import service barrels, not service internals; `.dependency-cruiser.cjs` enforces this.
- **Shared contracts:** `src/shared/` must not import backend, client, or component layers.

## Anti-Patterns

### Deep Service Imports

**What happens:** Code outside a service capsule imports `@/backend/services/<name>/service/...` or `@/backend/services/<name>/resources/...`.
**Why it's wrong:** It bypasses registry dependency checks, model ownership, and the public capsule API.
**Do this instead:** Export the needed capability from `src/backend/services/<name>/index.ts` and import `@/backend/services/<name>`; see `src/backend/orchestration/domain-bridges.orchestrator.ts:19`.

### Service-to-Service Orchestration Inside Services

**What happens:** A service imports another service's internals or orchestration module to complete a cross-domain workflow.
**Why it's wrong:** It creates cycles and hides coordination outside the orchestration layer.
**Do this instead:** Define a bridge type in the service capsule and wire it from `src/backend/orchestration/domain-bridges.orchestrator.ts`.

### tRPC Owning Business Workflows

**What happens:** Router procedures grow into long workflow implementations with DB, git, sessions, and external APIs mixed together.
**Why it's wrong:** Transport code becomes hard to test and reuse outside HTTP.
**Do this instead:** Keep Zod validation and response shaping in `src/backend/trpc/*.trpc.ts`; move cross-service workflow into `src/backend/orchestration/` or service capsule methods.

### Frontend Polling for Realtime Workspace State

**What happens:** Components repeatedly poll workspace summary state that is already available through `/snapshots`.
**Why it's wrong:** It duplicates the snapshot pipeline and increases backend load.
**Do this instead:** Use `src/client/hooks/use-project-snapshot-sync.ts` to update React Query caches from `/snapshots`; keep tRPC queries as bootstrap/fallback.

## Error Handling

**Strategy:** Validate at transport edges with Zod, throw `TRPCError` for typed API failures, log operational failures with scoped loggers, and keep background workflows best-effort with explicit recovery paths.

**Patterns:**
- tRPC uses Zod schemas and `TRPCError` for not found/precondition/internal failures (`src/backend/trpc/workspace.trpc.ts:218`).
- WebSocket handlers reject invalid upgrades with `sendBadRequest` and emit structured error messages (`src/backend/routers/websocket/chat.handler.ts:172`, `src/backend/routers/websocket/chat.handler.ts:144`).
- Server startup uses `runStartupTask` wrappers so reconciliation failures are logged without preventing boot (`src/backend/server.ts:294`).
- Workspace initialization catches failures, marks workspace failed, cleans up sessions/terminals/worktrees, and clears init modes (`src/backend/orchestration/workspace-init.orchestrator.ts:138`, `src/backend/orchestration/workspace-init.orchestrator.ts:1208`).
- Graceful shutdown stops WebSockets, sessions, terminals, schedulers, ratchet, periodic tasks, reconciliation, rate limiter, interceptors, loggers, and Prisma (`src/backend/server.ts:322`).

## Cross-Cutting Concerns

**Logging:** Use `createLogger` from `src/backend/services/logger.service.ts`; access it via `AppContext` in request/handler code when possible. Session traffic has dedicated file logging through session services.
**Validation:** Use Zod at tRPC and WebSocket boundaries; shared schemas live in `src/shared/` and backend-specific schemas in `src/backend/schemas/`.
**Authentication:** No app-level user authentication is detected. GitHub uses local `gh` auth through the GitHub service; Linear uses encrypted API key configuration.
**Authorization/Safety:** Workspace file/socket operations validate paths under worktree base directories (`src/backend/routers/websocket/chat.handler.ts:94`); command execution safety is mediated by ACP permission modes and service configuration.
**Configuration:** Centralized through `src/backend/services/config.service.ts`, environment schemas in `src/backend/services/env-schemas.ts`, and `factory-factory.json` project/worktree command config.
**Scheduling:** Long-running background loops live in `src/backend/orchestration/scheduler.service.ts`, `src/backend/services/ratchet/`, `src/backend/services/periodic-task/`, and snapshot reconciliation.

---

*Architecture analysis: 2026-05-17*
