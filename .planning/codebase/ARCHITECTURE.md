# Architecture

**Analysis Date:** 2026-04-29

## Pattern Overview

**Overall:** Modular full-stack monolith with backend service capsules, an orchestration layer, typed tRPC HTTP APIs, WebSocket streaming, and a React/Vite client. The same backend serves standalone CLI mode and Electron production mode.

**Key Characteristics:**
- Keep domain ownership in service capsules under `src/backend/services/{name}/`; expose each capsule through `src/backend/services/{name}/index.ts`.
- Coordinate workflows that touch multiple domains in `src/backend/orchestration/`; services should not import orchestration code.
- Use `src/backend/trpc/*.trpc.ts` for request/response APIs and `src/backend/routers/websocket/*.handler.ts` for live chat, terminal, logs, and snapshot streams.
- Store durable state in SQLite through Prisma accessors in `src/backend/services/*/resources/`; keep runtime state in service singletons and WebSocket connection maps.
- Share neutral contracts through `src/shared/` and the workspace package `packages/core/src/`; do not import UI or backend app layers from shared code.

## Layers

**Client Application Layer:**
- Purpose: Render routes, layouts, and route-local workflow UI.
- Location: `src/client/`
- Contains: route definitions in `src/client/router.tsx`, root providers in `src/client/root.tsx`, project layout in `src/client/layouts/project-layout.tsx`, and page modules under `src/client/routes/`.
- Depends on: shared components in `src/components/`, tRPC hooks in `src/client/lib/trpc.ts`, React Query provider wiring in `src/client/lib/providers.tsx`, and WebSocket hooks in `src/hooks/use-websocket-transport.ts`.
- Used by: Vite entrypoint `src/client/main.tsx` and Electron/CLI served frontend builds.

**Shared UI Component Layer:**
- Purpose: Provide reusable UI primitives and workflow components that client routes compose.
- Location: `src/components/`
- Contains: shadcn/Radix primitives in `src/components/ui/`, chat UI in `src/components/chat/`, workspace panels in `src/components/workspace/`, project setup forms in `src/components/project/`, and layout shell in `src/components/layout/resizable-layout.tsx`.
- Depends on: `src/client/lib/trpc.ts` for selected data-bound components, shared schemas/types in `src/shared/`, and UI utilities in `src/lib/`.
- Used by: route modules under `src/client/routes/` and client shell modules under `src/client/`.

**Client Data And Transport Layer:**
- Purpose: Bridge UI components to backend tRPC APIs and WebSocket streams.
- Location: `src/client/lib/`, `src/client/hooks/`, `src/hooks/`, and selected component hooks under `src/components/`.
- Contains: tRPC client factory in `src/client/lib/trpc.ts`, React Query/tRPC providers in `src/client/lib/providers.tsx`, project snapshot cache synchronization in `src/client/hooks/use-project-snapshot-sync.ts`, generic WebSocket reconnect/queue handling in `src/hooks/use-websocket-transport.ts`, chat transport composition in `src/components/chat/use-chat-websocket.ts`, and terminal transport in `src/components/workspace/use-terminal-websocket.ts`.
- Depends on: backend tRPC type surface from `src/backend/trpc/index.ts` only through `src/client/lib/trpc.ts`, shared WebSocket URL helpers in `src/lib/websocket-config.ts`, and shared schemas under `src/shared/`.
- Used by: route modules such as `src/client/routes/projects/workspaces/detail.tsx` and workspace UI components under `src/components/workspace/`.

**Backend Transport Layer:**
- Purpose: Expose HTTP, tRPC, health, static frontend, and WebSocket endpoints.
- Location: `src/backend/server.ts`, `src/backend/index.ts`, `src/backend/trpc/`, and `src/backend/routers/`.
- Contains: Express server creation in `src/backend/server.ts`, standalone process bootstrap in `src/backend/index.ts`, tRPC root router in `src/backend/trpc/index.ts`, tRPC context helpers in `src/backend/trpc/trpc.ts`, health router in `src/backend/routers/health.router.ts`, and WebSocket handlers under `src/backend/routers/websocket/`.
- Depends on: `src/backend/app-context.ts` for service injection, domain service barrels under `src/backend/services/{name}/`, orchestration modules under `src/backend/orchestration/`, middleware in `src/backend/middleware/`, and Prisma shutdown from `src/backend/db.ts`.
- Used by: CLI serve command in `src/cli/index.ts`, Electron production startup in `electron/main/server-manager.ts`, and direct Node execution of `src/backend/index.ts`.

**tRPC API Layer:**
- Purpose: Validate inputs, enforce API-level errors, and delegate domain work to services or orchestration functions.
- Location: `src/backend/trpc/`
- Contains: API routers such as `src/backend/trpc/workspace.trpc.ts`, `src/backend/trpc/session.trpc.ts`, `src/backend/trpc/project.trpc.ts`, `src/backend/trpc/github.trpc.ts`, `src/backend/trpc/linear.trpc.ts`, `src/backend/trpc/auto-iteration.trpc.ts`, and nested workspace routers under `src/backend/trpc/workspace/`.
- Depends on: Zod schemas, `TRPCError`, service barrels such as `@/backend/services/workspace`, and orchestration modules such as `src/backend/orchestration/workspace-init.orchestrator.ts` and `src/backend/orchestration/workspace-archive.orchestrator.ts`.
- Used by: `src/backend/server.ts` through `/api/trpc` and client hooks generated from `src/client/lib/trpc.ts`.

**WebSocket Layer:**
- Purpose: Stream bidirectional chat and terminal traffic plus receive-only logs and workspace snapshot changes.
- Location: `src/backend/routers/websocket/` and `src/hooks/use-websocket-transport.ts`.
- Contains: chat handler in `src/backend/routers/websocket/chat.handler.ts`, terminal handler in `src/backend/routers/websocket/terminal.handler.ts`, setup terminal handler in `src/backend/routers/websocket/setup-terminal.handler.ts`, snapshot handler in `src/backend/routers/websocket/snapshots.handler.ts`, dev log handler in `src/backend/routers/websocket/dev-logs.handler.ts`, and post-run log handler in `src/backend/routers/websocket/post-run-logs.handler.ts`.
- Depends on: `AppContext` services from `src/backend/app-context.ts`, shared message schemas under `src/shared/websocket/`, and WebSocket constants in `src/backend/constants/websocket.ts`.
- Used by: `src/backend/server.ts` upgrade routing and browser hooks under `src/components/chat/`, `src/components/workspace/`, `src/client/hooks/`, and `src/hooks/`.

**Orchestration Layer:**
- Purpose: Coordinate operations that intentionally cross service ownership boundaries.
- Location: `src/backend/orchestration/`
- Contains: bridge wiring in `src/backend/orchestration/domain-bridges.orchestrator.ts`, workspace initialization in `src/backend/orchestration/workspace-init.orchestrator.ts`, archive cleanup in `src/backend/orchestration/workspace-archive.orchestrator.ts`, event-to-snapshot collection in `src/backend/orchestration/event-collector.orchestrator.ts`, safety reconciliation in `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`, scheduler setup in `src/backend/orchestration/scheduler.service.ts`, and health composition in `src/backend/orchestration/health.service.ts`.
- Depends on: public service barrels under `src/backend/services/{name}/`, root infrastructure services under `src/backend/services/*.ts`, shared derivation functions under `src/shared/`, and Prisma-owned accessors exposed by service barrels.
- Used by: `src/backend/server.ts` startup/shutdown, tRPC procedures in `src/backend/trpc/`, and domain bridge configuration.

**Domain Service Capsule Layer:**
- Purpose: Own business behavior, state machines, bridge interfaces, and service-specific resources.
- Location: `src/backend/services/{session,workspace,github,linear,ratchet,terminal,run-script,settings,decision-log,auto-iteration}/`
- Contains: public barrels in `src/backend/services/{name}/index.ts`, business logic under `src/backend/services/{name}/service/`, resource accessors under `src/backend/services/{name}/resources/`, and co-located tests.
- Depends on: same-capsule internals, declared service dependencies from `src/backend/services/registry.ts` through public barrels, and root infrastructure services such as `src/backend/services/logger.service.ts`.
- Used by: tRPC routers, WebSocket handlers, orchestration modules, and `src/backend/app-context.ts`.

**Infrastructure Service Layer:**
- Purpose: Provide cross-cutting backend services that are not domain capsules.
- Location: root files under `src/backend/services/*.ts`, `src/backend/lib/`, `src/backend/clients/`, and `src/backend/middleware/`.
- Contains: logging in `src/backend/services/logger.service.ts`, config in `src/backend/services/config.service.ts`, rate limiting in `src/backend/services/rate-limiter.service.ts`, server instance tracking in `src/backend/services/server-instance.service.ts`, git operations in `src/backend/services/git-ops.service.ts`, and low-level helpers in `src/backend/lib/`.
- Depends on: Node APIs, external SDKs, and limited shared utilities; `src/backend/lib/` must remain low-level and avoid app-layer imports.
- Used by: service capsules, orchestration, transport setup, CLI, and Electron server management.

**Persistence Layer:**
- Purpose: Define and access durable app data.
- Location: `prisma/schema.prisma`, `prisma/migrations/`, `prisma/generated/`, `src/backend/db.ts`, `src/backend/migrate.ts`, and `src/backend/services/*/resources/`.
- Contains: Prisma models `Project`, `Workspace`, `AgentSession`, `TerminalSession`, `ClosedSession`, `UserSettings`, and `DecisionLog`; SQLite adapter setup in `src/backend/db.ts`; custom migration runner in `src/backend/migrate.ts`; and service resource accessors such as `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Depends on: Prisma generated client from `@prisma-gen/client`, better-sqlite3 adapter, and database path config from `src/backend/services/config.service.ts`.
- Used by: service resources, CLI migration commands in `src/cli/index.ts`, and Electron startup in `electron/main/server-manager.ts`.

**Shared Contract Layer:**
- Purpose: Keep UI/backend-neutral types, enums, schemas, and derivation helpers.
- Location: `src/shared/` and `packages/core/src/`.
- Contains: core enums in `src/shared/core/enums.ts`, ACP/chat protocol in `src/shared/acp-protocol/`, WebSocket schemas in `src/shared/websocket/`, issue tracker config schemas in `src/shared/schemas/issue-tracker-config.schema.ts`, factory config schema in `src/shared/schemas/factory-config.schema.ts`, and extracted core package exports in `packages/core/src/index.ts`.
- Depends on: neutral libraries such as Zod; shared code must not depend on `src/backend/`, `src/client/`, or `src/components/`.
- Used by: backend services and routers, client UI, tests, and `@factory-factory/core` package consumers.

**Runtime Entry Layer:**
- Purpose: Start the app in CLI, server, and Electron contexts.
- Location: `src/cli/`, `electron/`, `src/backend/index.ts`, and package scripts in `package.json`.
- Contains: CLI command definitions in `src/cli/index.ts`, proxy command in `src/cli/proxy.ts`, Electron main lifecycle in `electron/main/lifecycle.ts`, Electron backend manager in `electron/main/server-manager.ts`, Electron preload API in `electron/preload/index.ts`, and standalone backend bootstrap in `src/backend/index.ts`.
- Depends on: backend server factory `src/backend/server.ts`, migration runner `src/backend/migrate.ts`, local native module setup scripts under `scripts/`, and production build output under `dist/`.
- Used by: `pnpm dev`, `pnpm start`, `pnpm dev:electron`, `pnpm build:electron`, and installed `ff` CLI workflows.

## Data Flow

**Standalone Server Startup:**

1. `src/backend/index.ts` loads environment config, creates `AppContext` with `createAppContext()` from `src/backend/app-context.ts`, and calls `createServer()` from `src/backend/server.ts`.
2. `src/backend/server.ts` creates Express and HTTP servers, installs middleware from `src/backend/middleware/`, mounts `/health` and `/api/trpc`, creates WebSocket upgrade handlers from `src/backend/routers/websocket/`, and optionally serves built frontend assets from `FRONTEND_STATIC_PATH`.
3. On `start()`, `src/backend/server.ts` finds an available port, configures domain bridges with `src/backend/orchestration/domain-bridges.orchestrator.ts`, configures event collection and snapshot reconciliation, runs startup recovery, starts interceptors, starts rate limiting, starts scheduler, and starts ratchet polling.

**Client tRPC Request Flow:**

1. `src/client/main.tsx` renders `Router` from `src/client/router.tsx`.
2. `src/client/root.tsx` installs `ThemeProvider`, `TRPCProvider`, `WorkspaceNotificationManager`, and `AppLayout`.
3. `src/client/lib/providers.tsx` creates React Query and tRPC providers; `src/client/lib/trpc.ts` sends batched HTTP requests to `/api/trpc` and attaches project/task headers.
4. `src/backend/trpc/index.ts` routes each call to a router such as `src/backend/trpc/workspace.trpc.ts`.
5. tRPC procedures validate with Zod and delegate to service barrels such as `@/backend/services/workspace` or orchestration modules such as `src/backend/orchestration/workspace-init.orchestrator.ts`.

**Workspace Creation And Initialization Flow:**

1. `src/backend/trpc/workspace.trpc.ts` validates the discriminated workspace creation input with `workspaceCreationSourceSchema`.
2. `WorkspaceCreationService` from `src/backend/services/workspace/service/lifecycle/creation.service.ts` creates the durable workspace through accessors in `src/backend/services/workspace/resources/`.
3. `src/backend/trpc/workspace.trpc.ts` creates a default `AgentSession` through `sessionDataService` from `src/backend/services/session/` when capacity allows.
4. `initializeWorkspaceWorktree()` in `src/backend/orchestration/workspace-init.orchestrator.ts` runs in the background, transitions workspace state through `workspaceStateMachine`, creates or resumes a git worktree through `gitOpsService`, creates terminal/session runtime resources, resolves GitHub or Linear issue prompts, runs startup script pipeline, and marks the workspace `READY` or `FAILED`.
5. Domain events and reconciliation update `workspaceSnapshotStore` in `src/backend/services/workspace-snapshot-store.service.ts`, and `/snapshots` pushes the resulting state to clients.

**Workspace Snapshot Stream Flow:**

1. Domain services emit events such as `WORKSPACE_STATE_CHANGED`, `RUN_SCRIPT_STATUS_CHANGED`, `RATCHET_STATE_CHANGED`, and `PR_SNAPSHOT_UPDATED`.
2. `src/backend/orchestration/event-collector.orchestrator.ts` subscribes to domain events and coalesces per-workspace field updates into `workspaceSnapshotStore`.
3. `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts` periodically rebuilds authoritative snapshot fields from Prisma, session runtime state, pending requests, and git stats.
4. `src/backend/routers/websocket/snapshots.handler.ts` sends `snapshot_full`, `snapshot_changed`, and `snapshot_removed` messages scoped by `projectId`.
5. `src/client/hooks/use-project-snapshot-sync.ts` maps snapshot entries into React Query caches for `workspace.getProjectSummaryState`, `workspace.listWithKanbanState`, and `workspace.get`.

**Agent Chat Flow:**

1. `src/components/chat/use-chat-websocket.ts` connects to `/chat` through `src/hooks/use-websocket-transport.ts` using a stable `connectionId` and `sessionId`.
2. `src/backend/routers/websocket/chat.handler.ts` validates the optional working directory, registers the connection in `chatConnectionService`, logs traffic with `sessionFileLogger`, and delegates messages to `chatMessageHandlerService`.
3. `sessionService` from `src/backend/services/session/service/lifecycle/session.service.ts` starts or resumes ACP runtime clients through `AcpRuntimeManager` under `src/backend/services/session/service/acp/`.
4. ACP events are processed by session lifecycle services, pushed through `chatEventForwarderService`, and stored in `sessionDomainService` runtime state.
5. Interactive permission and question responses travel back over `/chat`, while workspace-level pending request state is reflected through the snapshot stream.

**Terminal Flow:**

1. `src/components/workspace/use-terminal-websocket.ts` connects to `/terminal` with a `workspaceId`.
2. `src/backend/routers/websocket/terminal.handler.ts` delegates terminal create/input/resize/destroy operations to `terminalService` from `src/backend/services/terminal/`.
3. Terminal metadata persists through `src/backend/services/terminal/resources/terminal-session.accessor.ts`, while live terminal I/O streams over WebSocket.

**State Management:**
- Durable state lives in SQLite through `prisma/schema.prisma`, `src/backend/db.ts`, and service accessors under `src/backend/services/*/resources/`.
- Backend runtime state lives in service singletons such as `sessionDomainService`, `chatConnectionService`, `terminalService`, `ratchetService`, and `workspaceSnapshotStore`.
- Cross-domain derived workspace state flows through `workspaceSnapshotStore` and is refreshed by `src/backend/orchestration/event-collector.orchestrator.ts` plus `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`.
- Client server state lives in React Query caches owned by `TRPCProvider` in `src/client/lib/providers.tsx`.
- Client live state enters through `src/hooks/use-websocket-transport.ts` and is normalized by hooks such as `src/client/hooks/use-project-snapshot-sync.ts`, `src/components/chat/use-chat-websocket.ts`, and `src/components/workspace/use-terminal-websocket.ts`.

## Key Abstractions

**AppContext:**
- Purpose: Central service/config dependency container used by transport and tests.
- Examples: `src/backend/app-context.ts`, `src/backend/server.ts`, `src/backend/trpc/trpc.ts`, `src/backend/routers/websocket/chat.handler.ts`
- Pattern: Create services with overridable defaults in `createServices()`, then pass `AppContext` into server, tRPC context, and WebSocket handler factories.

**Service Registry:**
- Purpose: Declare service capsule dependency direction and Prisma model ownership.
- Examples: `src/backend/services/registry.ts`, `scripts/check-service-registry.ts`, `.dependency-cruiser.cjs`
- Pattern: Add new capsule names to `serviceNames`, declare `dependsOn`, declare `ownsModels`, expose a public barrel, and let `pnpm check:ownership` validate ownership/import rules.

**Service Capsule Barrel:**
- Purpose: Provide the only public API for each backend domain capsule.
- Examples: `src/backend/services/workspace/index.ts`, `src/backend/services/session/index.ts`, `src/backend/services/ratchet/index.ts`, `src/backend/services/github/index.ts`
- Pattern: Consumers import `@/backend/services/{name}`; service internals import same-capsule files as needed; cross-service imports must target only the other service barrel and match `dependsOn`.

**Resource Accessor:**
- Purpose: Encapsulate Prisma access for service-owned models.
- Examples: `src/backend/services/workspace/resources/workspace.accessor.ts`, `src/backend/services/session/resources/agent-session.accessor.ts`, `src/backend/services/settings/resources/user-settings.accessor.ts`, `src/backend/services/decision-log/resources/decision-log.accessor.ts`
- Pattern: Keep direct `prisma` imports in `resources/`; use accessor methods from service logic, orchestration only through barrels, and tRPC only through service APIs.

**Workspace State Machine:**
- Purpose: Enforce valid workspace lifecycle transitions and emit lifecycle events.
- Examples: `src/backend/services/workspace/service/lifecycle/state-machine.service.ts`, `src/backend/orchestration/workspace-init.orchestrator.ts`, `src/backend/orchestration/workspace-archive.orchestrator.ts`
- Pattern: Use `workspaceStateMachine` for status changes; avoid direct status updates from callers.

**Domain Bridges:**
- Purpose: Wire cross-service capabilities without service-to-service internal coupling.
- Examples: `src/backend/orchestration/domain-bridges.orchestrator.ts`, bridge types in `src/backend/services/session/service/bridges.ts`, `src/backend/services/workspace/service/bridges.ts`, `src/backend/services/ratchet/service/bridges.ts`, and `src/backend/services/auto-iteration/service/bridges.ts`
- Pattern: Define bridge interfaces in the owning service capsule; implement and inject them from orchestration at startup.

**Workspace Snapshot Store:**
- Purpose: Maintain in-memory, derived, per-workspace state for fast sidebar/kanban/detail UI updates.
- Examples: `src/backend/services/workspace-snapshot-store.service.ts`, `src/backend/orchestration/event-collector.orchestrator.ts`, `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`, `src/backend/routers/websocket/snapshots.handler.ts`, `src/client/hooks/use-project-snapshot-sync.ts`
- Pattern: Mutate snapshots through event collector/reconciliation; stream changes through `/snapshots`; map snapshot entries into client caches.

**ACP Session Runtime:**
- Purpose: Run provider-backed agent sessions through Agent Client Protocol.
- Examples: `src/backend/services/session/service/acp/`, `src/backend/services/session/service/lifecycle/session.service.ts`, `src/backend/services/session/service/lifecycle/acp-event-processor.ts`, `src/cli/index.ts`
- Pattern: Keep ACP process/client internals isolated under `src/backend/services/session/service/acp/`; session lifecycle and chat handlers communicate through public session services.

**tRPC Router:**
- Purpose: Provide typed HTTP API procedures with schema validation.
- Examples: `src/backend/trpc/index.ts`, `src/backend/trpc/workspace.trpc.ts`, `src/backend/trpc/session.trpc.ts`, `src/backend/trpc/procedures/project-scoped.ts`
- Pattern: Validate inputs with Zod, throw `TRPCError` for API failures, delegate domain behavior to services or orchestration, and keep Prisma access out of routers.

**WebSocket Handler Factory:**
- Purpose: Create endpoint-specific upgrade handlers with `AppContext` dependencies.
- Examples: `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/terminal.handler.ts`, `src/backend/routers/websocket/snapshots.handler.ts`, `src/backend/routers/websocket/upgrade-utils.ts`
- Pattern: Parse/validate URL params and messages at the edge, register connection state, delegate domain work to services, and keep shared connection utility code in `upgrade-utils.ts`.

## Entry Points

**Frontend Browser App:**
- Location: `src/client/main.tsx`
- Triggers: Vite dev server or built frontend bundle loaded by Express/Electron.
- Responsibilities: Import global CSS, find `#root`, and render `Router` in React strict mode.

**Client Router:**
- Location: `src/client/router.tsx`
- Triggers: Browser route resolution.
- Responsibilities: Define routes for `/`, `/projects`, `/projects/new`, `/projects/:slug/workspaces`, `/projects/:slug/workspaces/:id`, `/reviews`, `/admin`, `/logs`, and development-only `/__mobile-baseline`.

**Client Root Providers:**
- Location: `src/client/root.tsx`
- Triggers: Root route element.
- Responsibilities: Install theme, tRPC/React Query, workspace notifications, CLI health banner, layout shell, route outlet, and toaster.

**Standalone Backend:**
- Location: `src/backend/index.ts`
- Triggers: `tsx src/backend/index.ts`, compiled `dist/src/backend/index.js`, or CLI production serve process.
- Responsibilities: Create `AppContext`, create server instance, register it in `serverInstanceService`, start it, and handle process signals/errors.

**Backend Server Factory:**
- Location: `src/backend/server.ts`
- Triggers: `src/backend/index.ts` and Electron production server manager.
- Responsibilities: Build Express/HTTP/WebSocket server, mount routes, serve static frontend, run startup recovery, configure orchestration, start/stop periodic services, and clean up Prisma/runtime resources.

**tRPC Root Router:**
- Location: `src/backend/trpc/index.ts`
- Triggers: Express `/api/trpc` middleware in `src/backend/server.ts`.
- Responsibilities: Compose domain routers and export `AppRouter` for frontend typing.

**CLI:**
- Location: `src/cli/index.ts`
- Triggers: `ff` binary and package scripts such as `pnpm dev`, `pnpm start`, and `pnpm build`.
- Responsibilities: Serve dev/prod app, run migrations, open Prisma Studio, build backend/frontend, start proxy tunnel, and expose hidden ACP adapter command.

**Electron Main Process:**
- Location: `electron/main/index.ts`
- Triggers: Electron runtime.
- Responsibilities: Register fatal error handlers, create `ServerManager`, create Electron lifecycle controller, register IPC/app handlers, and start app lifecycle.

**Electron Backend Manager:**
- Location: `electron/main/server-manager.ts`
- Triggers: Electron lifecycle window creation.
- Responsibilities: Use Vite dev URL in dev mode, or set production env vars, run migrations, dynamically import built backend server, and manage backend lifecycle in-process.

**Electron Preload:**
- Location: `electron/preload/index.ts`
- Triggers: BrowserWindow preload.
- Responsibilities: Expose safe `electronAPI.showOpenDialog` and window focus subscription APIs through `contextBridge`.

**Database Schema And Migrations:**
- Location: `prisma/schema.prisma`, `prisma/migrations/`, `src/backend/migrate.ts`
- Triggers: Prisma workflows, CLI `db:migrate`, CLI/Electron startup migration runners.
- Responsibilities: Define durable models/enums, provide generated client output under `prisma/generated/`, and apply SQLite migrations without relying on Prisma CLI at runtime.

## Error Handling

**Strategy:** Validate at transport boundaries, enforce state transitions in services, use typed API errors for client-visible failures, log internal failures with contextual metadata, and run startup reconciliation to recover persisted transient states.

**Patterns:**
- Use Zod schemas at API and WebSocket boundaries in files such as `src/backend/trpc/workspace.trpc.ts`, `src/backend/schemas/tool-inputs.schema.ts`, and `src/shared/websocket/chat-message.schema.ts`.
- Use `TRPCError` for tRPC client-visible status codes in routers such as `src/backend/trpc/workspace.trpc.ts` and orchestration functions such as `src/backend/orchestration/workspace-archive.orchestrator.ts`.
- Use domain-specific errors for lifecycle invariants, especially `WorkspaceStateMachineError` in `src/backend/services/workspace/service/lifecycle/state-machine.service.ts`.
- Convert unknown errors for logging with helpers from `src/backend/lib/error-utils.ts`.
- Recover persisted transient states on server start in `src/backend/server.ts` through ratchet reconciliation, workspace reconciliation, run-script recovery, archive recovery, and auto-iteration state reset.
- Keep best-effort external sync failures non-fatal where the core workspace operation should continue, such as GitHub/Linear side effects in `src/backend/orchestration/workspace-archive.orchestrator.ts` and `src/backend/orchestration/workspace-init.orchestrator.ts`.

## Cross-Cutting Concerns

**Logging:** Use `createLogger` from `src/backend/services/logger.service.ts`; obtain contextual loggers from `AppContext` in transport code such as `src/backend/trpc/workspace.trpc.ts` and `src/backend/routers/websocket/chat.handler.ts`.

**Validation:** Use Zod for API payloads, shared schemas, and config blobs in files such as `src/backend/trpc/workspace.trpc.ts`, `src/shared/schemas/factory-config.schema.ts`, and `src/shared/schemas/issue-tracker-config.schema.ts`.

**Authentication:** App-level user authentication is not modeled in tRPC; GitHub relies on local `gh` auth through `src/backend/services/github/service/github-cli.service.ts`, Linear uses encrypted API-key config through `src/backend/services/linear/`, and the public proxy command can add password/cookie protection in `src/cli/proxy.ts`.

**Authorization/Safety:** Workspace file and process operations enforce path and boundary checks in modules such as `src/backend/routers/websocket/chat.handler.ts`, `src/backend/services/workspace/service/worktree/worktree-lifecycle.service.ts`, and `src/backend/lib/file-helpers.ts`.

**Import Boundaries:** Dependency rules live in `.dependency-cruiser.cjs`; service ownership and service dependency rules live in `src/backend/services/registry.ts` and `scripts/check-service-registry.ts`.

**Project Skills:** No local project skill indexes are present under `.claude/skills/` or `.agents/skills/`; follow repository instructions in `AGENTS.md`.

---

*Architecture analysis: 2026-04-29*
