# Codebase Structure

**Analysis Date:** 2026-05-17

## Directory Layout

```text
factory-factory/
├── src/backend/                 # Express/tRPC/WebSocket backend and backend-only services
├── src/backend/services/        # Service capsules plus root infrastructure services
├── src/backend/orchestration/   # Cross-service workflow coordination and bridge wiring
├── src/backend/trpc/            # Typed HTTP API routers
├── src/backend/routers/         # Non-tRPC HTTP routes and WebSocket upgrade handlers
├── src/client/                  # React app routes, layouts, hooks, providers, client helpers
├── src/components/              # Shared UI, chat, workspace, project, and shadcn components
├── src/hooks/                   # Shared React hooks used outside client-only route modules
├── src/lib/                     # Frontend/shared pure helpers and protocol utilities
├── src/shared/                  # Backend/frontend-neutral contracts, schemas, enums, helpers
├── src/cli/                     # Published CLI binary and command helpers
├── src/test-utils/              # Shared test utilities
├── electron/                    # Electron main/preload wrapper
├── prisma/                      # Prisma schema, migrations, generated client
├── prompts/                     # Runtime prompt templates copied to dist on build
├── packages/core/               # Core package source and tests
├── scripts/                     # Build, validation, migration, native-module scripts
├── docs/                        # User/design documentation
├── e2e/                         # Playwright mobile baseline specs and snapshots
├── public/                      # Static assets and logos
├── biome-rules/                 # Custom Biome/Grit rule files
└── .planning/codebase/          # Generated codebase map documents
```

## Directory Purposes

**`src/backend/`:**
- Purpose: Backend runtime for the CLI/server/Electron app.
- Contains: `server.ts`, `index.ts`, `app-context.ts`, database setup, tRPC routers, WebSocket handlers, services, orchestration, middleware, testing utilities.
- Key files: `src/backend/server.ts`, `src/backend/index.ts`, `src/backend/app-context.ts`, `src/backend/db.ts`

**`src/backend/services/`:**
- Purpose: Domain service capsules and cross-cutting infrastructure services.
- Contains: Registered capsule directories such as `session`, `workspace`, `github`, `linear`, `ratchet`, `terminal`, `run-script`, `settings`, `decision-log`, `auto-iteration`, `periodic-task`, plus root infrastructure files like `logger.service.ts` and `config.service.ts`.
- Key files: `src/backend/services/registry.ts`, `src/backend/services/session/index.ts`, `src/backend/services/workspace/index.ts`

**`src/backend/services/{name}/service/`:**
- Purpose: Business logic for a single service capsule.
- Contains: domain services, state machines, bridge interfaces, runtime managers, helpers, and co-located tests.
- Key files: `src/backend/services/session/service/lifecycle/session.service.ts`, `src/backend/services/workspace/service/lifecycle/creation.service.ts`, `src/backend/services/ratchet/service/ratchet.service.ts`

**`src/backend/services/{name}/resources/`:**
- Purpose: Prisma accessors for models owned by a capsule.
- Contains: model-specific accessors and resource tests.
- Key files: `src/backend/services/workspace/resources/workspace.accessor.ts`, `src/backend/services/session/resources/agent-session.accessor.ts`, `src/backend/services/settings/resources/user-settings.accessor.ts`

**`src/backend/orchestration/`:**
- Purpose: Cross-service workflows that intentionally span capsules.
- Contains: bridge wiring, workspace init/archive, snapshot event collector/reconciliation, scheduler, CLI health, data backup, decision-log query helpers.
- Key files: `src/backend/orchestration/domain-bridges.orchestrator.ts`, `src/backend/orchestration/workspace-init.orchestrator.ts`, `src/backend/orchestration/event-collector.orchestrator.ts`, `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`

**`src/backend/trpc/`:**
- Purpose: Typed HTTP API surface for the React client.
- Contains: `index.ts` root router, `trpc.ts` context/helpers, domain `*.trpc.ts` routers, nested workspace routers.
- Key files: `src/backend/trpc/index.ts`, `src/backend/trpc/workspace.trpc.ts`, `src/backend/trpc/session.trpc.ts`, `src/backend/trpc/workspace/files.trpc.ts`

**`src/backend/routers/`:**
- Purpose: Non-tRPC backend routes.
- Contains: health router and WebSocket upgrade handlers.
- Key files: `src/backend/routers/health.router.ts`, `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/snapshots.handler.ts`

**`src/client/`:**
- Purpose: Application-specific React shell.
- Contains: Vite entry, router, root layout, project/workspace/admin/review/log routes, client-only hooks, React Query/tRPC providers, cache mappers.
- Key files: `src/client/main.tsx`, `src/client/router.tsx`, `src/client/root.tsx`, `src/client/lib/trpc.ts`, `src/client/hooks/use-project-snapshot-sync.ts`

**`src/client/routes/`:**
- Purpose: Page-level route modules.
- Contains: `home`, `reviews`, `logs`, `admin-page`, project list/new/redirect pages, workspace list/new/detail pages, route-specific hooks/components.
- Key files: `src/client/routes/projects/workspaces/detail.tsx`, `src/client/routes/projects/workspaces/list.tsx`, `src/client/routes/admin-page.tsx`

**`src/components/`:**
- Purpose: Shared UI and feature components consumed by routes.
- Contains: `ui/` shadcn primitives, `chat/`, `workspace/`, `kanban/`, `project/`, `layout/`, `agent-activity/`, shared components, Storybook stories, tests.
- Key files: `src/components/chat/use-chat-websocket.ts`, `src/components/workspace/terminal-panel.tsx`, `src/components/ui/button.tsx`

**`src/hooks/`:**
- Purpose: Shared React hooks that are not route-specific.
- Contains: WebSocket transport, visual viewport helpers, mobile state helpers.
- Key files: `src/hooks/use-websocket-transport.ts`, `src/hooks/use-visual-viewport-height.ts`

**`src/lib/`:**
- Purpose: Client/shared pure utilities.
- Contains: chat protocol helpers, websocket config, paste/image utilities, formatting, session provider selection, diff helpers.
- Key files: `src/lib/websocket-config.ts`, `src/lib/chat-protocol.ts`, `src/lib/session-provider-selection.ts`

**`src/shared/`:**
- Purpose: Framework-neutral contracts used by frontend and backend.
- Contains: core enums, ACP protocol schemas, websocket schemas, pending request helpers, issue tracker schemas, factory config schemas.
- Key files: `src/shared/core/index.ts`, `src/shared/acp-protocol/index.ts`, `src/shared/websocket/index.ts`, `src/shared/schemas/factory-config.schema.ts`

**`src/cli/`:**
- Purpose: Published `ff` command-line interface.
- Contains: command registration, serve/build/migrate/proxy handling, database path resolution, runtime utilities.
- Key files: `src/cli/index.ts`, `src/cli/database-path.ts`, `src/cli/proxy.ts`, `src/cli/serve-env.ts`

**`electron/`:**
- Purpose: Desktop app wrapper around the same backend/frontend app.
- Contains: Electron main process, server manager, lifecycle controller, preload bridge, tests.
- Key files: `electron/main/index.ts`, `electron/main/server-manager.ts`, `electron/main/lifecycle.ts`, `electron/preload/index.ts`

**`prisma/`:**
- Purpose: Database schema, generated client, and migrations.
- Contains: `schema.prisma`, migration SQL directories, generated Prisma client output.
- Key files: `prisma/schema.prisma`, `prisma.config.ts`, `prisma/migrations/`

**`prompts/`:**
- Purpose: Prompt templates used by runtime workflows and quick actions.
- Contains: quick-action markdown, workflow markdown, ratchet dispatch prompt.
- Key files: `prompts/quick-actions/review.md`, `prompts/workflows/bugfix.md`, `prompts/ratchet/dispatch.md`

**`packages/core/`:**
- Purpose: Core package exported separately from the app.
- Contains: package source, generated dist output, package tests.
- Key files: `packages/core/src/index.ts`, `packages/core/src/types/enums.ts`, `packages/core/src/shared/ci-status.ts`

**`scripts/`:**
- Purpose: Build-time and validation automation.
- Contains: service registry checks, import checks, environment checks, migration/native-module scripts.
- Key files: `scripts/check-service-registry.ts`, `scripts/check-ambiguous-relative-imports.mjs`, `scripts/check-no-direct-process-env.mjs`

## Key File Locations

**Entry Points:**
- `src/cli/index.ts`: Published CLI binary and development/production process orchestration.
- `src/backend/index.ts`: Standalone backend process entry.
- `src/backend/server.ts`: Server factory used by CLI and Electron.
- `src/client/main.tsx`: Browser React entry.
- `src/client/router.tsx`: React Router route tree.
- `electron/main/index.ts`: Electron main entry.
- `electron/preload/index.ts`: Renderer preload bridge.

**Configuration:**
- `package.json`: npm scripts, dependency graph, binary definition.
- `tsconfig.json`: strict TypeScript config and aliases `@/*`, `@prisma-gen/*`, `@factory-factory/core-types/*`.
- `tsconfig.backend.json`: backend build config.
- `vite.config.ts`: React/Vite build and dev proxy for `/api`, `/chat`, `/terminal`, `/snapshots`, and log sockets.
- `vitest.config.ts`: Vitest config.
- `biome.json`: Biome lint/format config.
- `.dependency-cruiser.cjs`: Architecture boundary rules.
- `components.json`: shadcn/ui component configuration.
- `factory-factory.json`: Project runtime script config example for this repo.
- `.env.example`: Example environment configuration; do not read real `.env` files.

**Core Backend Logic:**
- `src/backend/app-context.ts`: Service graph construction.
- `src/backend/services/registry.ts`: Capsule dependencies and model ownership.
- `src/backend/orchestration/domain-bridges.orchestrator.ts`: Cross-domain bridge wiring.
- `src/backend/orchestration/workspace-init.orchestrator.ts`: Worktree/session/terminal/startup-script initialization workflow.
- `src/backend/orchestration/event-collector.orchestrator.ts`: Domain events to snapshot updates.
- `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`: Periodic authoritative snapshot rebuild.
- `src/backend/services/workspace-snapshot-store.service.ts`: In-memory snapshot store and derived state.
- `src/backend/db.ts`: Prisma client singleton.

**API and Realtime:**
- `src/backend/trpc/index.ts`: Root tRPC router.
- `src/backend/trpc/trpc.ts`: tRPC context and public procedure helpers.
- `src/backend/trpc/workspace.trpc.ts`: Workspace API.
- `src/backend/trpc/session.trpc.ts`: Session and terminal-session API.
- `src/backend/routers/websocket/chat.handler.ts`: Chat WebSocket.
- `src/backend/routers/websocket/terminal.handler.ts`: Terminal WebSocket.
- `src/backend/routers/websocket/snapshots.handler.ts`: Snapshot WebSocket.

**Frontend Logic:**
- `src/client/lib/providers.tsx`: React Query and tRPC provider.
- `src/client/lib/trpc.ts`: Typed tRPC client and only allowed frontend import of backend tRPC types.
- `src/client/hooks/use-project-snapshot-sync.ts`: Snapshot WebSocket cache synchronization.
- `src/components/chat/use-chat-websocket.ts`: Chat WebSocket composition.
- `src/components/chat/reducer/`: Chat state reducer slices.
- `src/components/workspace/use-terminal-websocket.ts`: Terminal WebSocket hook.
- `src/client/routes/projects/workspaces/use-workspace-detail.ts`: Workspace detail data/session management hook.

**Data Models:**
- `prisma/schema.prisma`: SQLite models and enums.
- `src/backend/services/workspace/resources/project.accessor.ts`: Project resource accessor.
- `src/backend/services/workspace/resources/workspace.accessor.ts`: Workspace resource accessor.
- `src/backend/services/session/resources/agent-session.accessor.ts`: Agent session resource accessor.
- `src/backend/services/periodic-task/resources/periodic-task.accessor.ts`: Periodic task resource accessor.

**Testing:**
- `src/backend/testing/setup.ts`: Backend test setup.
- `src/backend/testing/integration-db.ts`: Integration DB utilities.
- `src/test-utils/`: Shared test helpers.
- Co-located `*.test.ts` and `*.test.tsx` files throughout `src/backend/`, `src/client/`, `src/components/`, `src/shared/`, and `packages/core/src/`.
- `e2e/mobile-baseline.spec.ts`: Playwright mobile baseline e2e test.

## Naming Conventions

**Files:**
- Backend tRPC routers: `*.trpc.ts`, for example `src/backend/trpc/workspace.trpc.ts`.
- Backend non-tRPC routers: `*.router.ts`, for example `src/backend/routers/health.router.ts`.
- Backend services: `*.service.ts`, for example `src/backend/services/ratchet/service/ratchet.service.ts`.
- Backend orchestrators: `*.orchestrator.ts`, for example `src/backend/orchestration/workspace-init.orchestrator.ts`.
- Resource accessors: `*.accessor.ts`, for example `src/backend/services/workspace/resources/workspace.accessor.ts`.
- React components: kebab-case `.tsx`, for example `src/components/workspace/terminal-panel.tsx`.
- React hooks: `use-*.ts` or `use-*.tsx`, for example `src/hooks/use-websocket-transport.ts`.
- Tests: co-located `*.test.ts` and `*.test.tsx`.
- Stories: co-located `*.stories.tsx`.

**Directories:**
- Service capsules: `src/backend/services/{service-name}/` with kebab-case names such as `run-script` and `periodic-task`.
- Capsule internals: `service/` for business logic and `resources/` for DB access.
- Route modules: `src/client/routes/{area}/`.
- Shared UI domains: `src/components/{domain}/`.
- shadcn primitives: `src/components/ui/`.
- Shared contracts: `src/shared/{domain}/`.

## Where to Add New Code

**New Backend Service Capsule:**
- Primary code: `src/backend/services/{name}/service/`
- Resource accessors: `src/backend/services/{name}/resources/`
- Public API: `src/backend/services/{name}/index.ts`
- Registry: `src/backend/services/registry.ts`
- Tests: co-located under `src/backend/services/{name}/`
- Validation: run `pnpm check:service-registry` and `pnpm deps:check`.

**New API Procedure:**
- Primary code: existing domain router in `src/backend/trpc/*.trpc.ts` or nested `src/backend/trpc/{domain}/*.trpc.ts`.
- Root registration: `src/backend/trpc/index.ts` when adding a new router namespace.
- Input schemas: inline Zod for router-local shapes or shared schema in `src/shared/` when frontend/backend contracts are reused.
- Business logic: service capsule or `src/backend/orchestration/`, not long workflow code in the router.

**New WebSocket Channel:**
- Backend handler: `src/backend/routers/websocket/{name}.handler.ts`
- Backend export: `src/backend/routers/websocket/index.ts`
- Upgrade routing: `src/backend/server.ts`
- Frontend hook: `src/hooks/` for generic transport composition or `src/components/{domain}/` for feature-specific use.
- Shared schemas: `src/shared/websocket/` or `src/backend/schemas/` depending on whether the client imports them.

**New Cross-Service Workflow:**
- Primary code: `src/backend/orchestration/{workflow}.orchestrator.ts`
- Service collaboration: bridge interfaces in `src/backend/services/{name}/service/bridges.ts`, concrete wiring in `src/backend/orchestration/domain-bridges.orchestrator.ts`.
- Avoid direct service-internal imports from orchestration; use service barrels.

**New Prisma Model or DB Access:**
- Schema: `prisma/schema.prisma`
- Migration: `prisma/migrations/`
- Owner declaration: `src/backend/services/registry.ts`
- Accessor: `src/backend/services/{owning-service}/resources/{model}.accessor.ts`
- Public use: expose necessary methods through `src/backend/services/{owning-service}/index.ts`.

**New React Page:**
- Route component: `src/client/routes/{area}/`
- Router registration: `src/client/router.tsx`
- Route-specific hooks/helpers: same route directory.
- Shared reusable UI: `src/components/{domain}/` or `src/client/components/` depending on reuse scope.

**New Shared UI Component:**
- shadcn primitive or wrapper: `src/components/ui/`
- Feature component: `src/components/{domain}/`
- App-shell-specific component: `src/client/components/`
- Storybook story: co-located `*.stories.tsx` when UI behavior/variants matter.
- Tests: co-located `*.test.tsx` for logic, state, or regression coverage.

**New Frontend Data Hook:**
- tRPC/cache hook tied to app routes: `src/client/hooks/` or route directory.
- Generic reusable hook: `src/hooks/`.
- WebSocket URL building: use `src/lib/websocket-config.ts`.
- API access: use `src/client/lib/trpc.ts`; do not import backend modules directly.

**New Shared Contract:**
- Cross-runtime enums/helpers: `src/shared/core/` or `src/shared/`.
- WebSocket schemas: `src/shared/websocket/`.
- ACP protocol contracts: `src/shared/acp-protocol/`.
- Exported core package types: `packages/core/src/types/` when package consumers need them.

**New Prompt Template:**
- Quick action: `prompts/quick-actions/{id}.md`
- Workflow prompt: `prompts/workflows/{id}.md`
- Ratchet prompt: `prompts/ratchet/`
- Backend loader/update: `src/backend/prompts/`

## Special Directories

**`prisma/generated/`:**
- Purpose: Generated Prisma client.
- Generated: Yes
- Committed: Yes in this tree; dependency-cruiser excludes it from analysis.

**`dist/`:**
- Purpose: Build output for backend and frontend.
- Generated: Yes
- Committed: No for normal source changes.

**`node_modules/`:**
- Purpose: Installed dependencies.
- Generated: Yes
- Committed: No.

**`.planning/`:**
- Purpose: GSD planning, phases, milestones, research, and codebase maps.
- Generated: Partially
- Committed: Project workflow artifacts may be committed by orchestrator; mapper writes only `.planning/codebase/`.

**`.factory-factory/`:**
- Purpose: Local runtime artifacts such as screenshots.
- Generated: Yes
- Committed: Some screenshots may be committed when explicitly produced for UI verification.

**`.native-cache/`:**
- Purpose: Cached native modules for Node/Electron ABI compatibility.
- Generated: Yes
- Committed: No.

**`prompts/`:**
- Purpose: Runtime prompt templates copied into `dist/` during build.
- Generated: No
- Committed: Yes.

**`public/`:**
- Purpose: Static frontend assets including logos, sounds, and images.
- Generated: No
- Committed: Yes.

**`biome-rules/`:**
- Purpose: Custom Grit rules used with Biome/project checks.
- Generated: No
- Committed: Yes.

---

*Structure analysis: 2026-05-17*
