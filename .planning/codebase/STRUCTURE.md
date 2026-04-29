# Codebase Structure

**Analysis Date:** 2026-04-29

## Directory Layout

```text
factory-factory-2/
|-- src/
|   |-- backend/          # Express, tRPC, WebSocket, orchestration, services, Prisma access
|   |-- client/           # React app shell, routes, client hooks, client data mappers
|   |-- components/       # Shared React components and shadcn/Radix UI primitives
|   |-- hooks/            # Cross-client React hooks such as WebSocket transport
|   |-- lib/              # Frontend/shared utility modules
|   |-- shared/           # UI/backend-neutral contracts, schemas, enums, protocol types
|   |-- cli/              # ff CLI entrypoint and commands
|   |-- test-utils/       # Shared test helpers
|   `-- types/            # Global/browser/Electron type surfaces
|-- electron/             # Electron main and preload processes
|-- prisma/               # Prisma schema, generated client, migrations
|-- packages/core/        # Extracted @factory-factory/core package
|-- prompts/              # Runtime prompt templates copied into dist
|-- scripts/              # Build, validation, native module, and ownership scripts
|-- docs/                 # Design and project documentation
|-- e2e/                  # Playwright end-to-end tests
|-- public/               # Static frontend assets
|-- .storybook/           # Storybook configuration
|-- .planning/            # GSD planning state and codebase maps
|-- package.json          # Scripts and package dependencies
|-- vite.config.ts        # Vite frontend/dev server config
|-- vitest.config.ts      # Vitest config
|-- tsconfig.json         # Full-project TypeScript config
|-- tsconfig.backend.json # Backend build TypeScript config
|-- tsconfig.electron.json # Electron build TypeScript config
|-- biome.json            # Formatting/linting config
`-- .dependency-cruiser.cjs # Architecture import-boundary rules
```

## Directory Purposes

**`src/backend/`:**
- Purpose: Own backend server runtime, API transports, domain services, orchestration, persistence access, middleware, and backend utilities.
- Contains: server factory `src/backend/server.ts`, standalone entrypoint `src/backend/index.ts`, service container `src/backend/app-context.ts`, Prisma client setup `src/backend/db.ts`, migration runner `src/backend/migrate.ts`, tRPC routers under `src/backend/trpc/`, WebSocket handlers under `src/backend/routers/websocket/`, service capsules under `src/backend/services/{name}/`, orchestration under `src/backend/orchestration/`, and backend tests co-located with modules.
- Key files: `src/backend/server.ts`, `src/backend/index.ts`, `src/backend/app-context.ts`, `src/backend/services/registry.ts`, `src/backend/trpc/index.ts`, `src/backend/routers/websocket/index.ts`

**`src/backend/services/`:**
- Purpose: Hold domain capsules plus root infrastructure services.
- Contains: service capsule directories `src/backend/services/session/`, `src/backend/services/workspace/`, `src/backend/services/github/`, `src/backend/services/linear/`, `src/backend/services/ratchet/`, `src/backend/services/terminal/`, `src/backend/services/run-script/`, `src/backend/services/settings/`, `src/backend/services/decision-log/`, and `src/backend/services/auto-iteration/`; root infrastructure services such as `src/backend/services/logger.service.ts`, `src/backend/services/config.service.ts`, `src/backend/services/git-ops.service.ts`, and `src/backend/services/rate-limiter.service.ts`.
- Key files: `src/backend/services/registry.ts`, `src/backend/services/workspace/index.ts`, `src/backend/services/session/index.ts`, `src/backend/services/ratchet/index.ts`, `src/backend/services/workspace-snapshot-store.service.ts`

**`src/backend/services/{name}/`:**
- Purpose: Implement a backend domain capsule with a single public API.
- Contains: public barrel `src/backend/services/{name}/index.ts`, business logic under `src/backend/services/{name}/service/`, data access under `src/backend/services/{name}/resources/` when the service owns Prisma models, and co-located tests.
- Key files: `src/backend/services/workspace/service/lifecycle/state-machine.service.ts`, `src/backend/services/session/service/lifecycle/session.service.ts`, `src/backend/services/ratchet/service/ratchet.service.ts`, `src/backend/services/run-script/service/run-script-state-machine.service.ts`

**`src/backend/orchestration/`:**
- Purpose: Coordinate workflows that cross service boundaries.
- Contains: bridge wiring, workspace init/archive workflows, event collector, snapshot reconciliation, scheduler, health composition, and orchestration tests.
- Key files: `src/backend/orchestration/domain-bridges.orchestrator.ts`, `src/backend/orchestration/workspace-init.orchestrator.ts`, `src/backend/orchestration/workspace-archive.orchestrator.ts`, `src/backend/orchestration/event-collector.orchestrator.ts`, `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`

**`src/backend/trpc/`:**
- Purpose: Define typed HTTP API routers and procedures.
- Contains: root router `src/backend/trpc/index.ts`, tRPC setup `src/backend/trpc/trpc.ts`, project/workspace/session/admin routers, nested workspace routers under `src/backend/trpc/workspace/`, and co-located router tests.
- Key files: `src/backend/trpc/workspace.trpc.ts`, `src/backend/trpc/session.trpc.ts`, `src/backend/trpc/project.trpc.ts`, `src/backend/trpc/procedures/project-scoped.ts`

**`src/backend/routers/`:**
- Purpose: Define non-tRPC HTTP and WebSocket transports.
- Contains: health router `src/backend/routers/health.router.ts` and WebSocket handlers under `src/backend/routers/websocket/`.
- Key files: `src/backend/routers/websocket/chat.handler.ts`, `src/backend/routers/websocket/terminal.handler.ts`, `src/backend/routers/websocket/snapshots.handler.ts`, `src/backend/routers/websocket/upgrade-utils.ts`

**`src/backend/lib/`:**
- Purpose: Provide low-level backend helper functions that stay below services and transports.
- Contains: environment helpers, file helpers, git helpers, shell helpers, provider selection helpers, session summaries, workspace derived-state helpers, and tests.
- Key files: `src/backend/lib/error-utils.ts`, `src/backend/lib/env.ts`, `src/backend/lib/file-helpers.ts`, `src/backend/lib/git-helpers.ts`, `src/backend/lib/session-summaries.ts`, `src/backend/lib/workspace-derived-state.ts`

**`src/backend/middleware/`:**
- Purpose: Encapsulate Express middleware creation.
- Contains: CORS, request logging, security middleware, index exports, and middleware tests.
- Key files: `src/backend/middleware/cors.middleware.ts`, `src/backend/middleware/request-logger.middleware.ts`, `src/backend/middleware/security.middleware.ts`, `src/backend/middleware/index.ts`

**`src/backend/interceptors/`:**
- Purpose: Detect and react to git/session conversation events around branch rename, PR detection, pre-push, and pre-PR behavior.
- Contains: interceptor implementations, registry, shared types, utilities, and tests.
- Key files: `src/backend/interceptors/registry.ts`, `src/backend/interceptors/types.ts`, `src/backend/interceptors/pr-detection.interceptor.ts`, `src/backend/interceptors/branch-rename.interceptor.ts`

**`src/client/`:**
- Purpose: Own React app bootstrapping, routes, layouts, client-specific components, hooks, and data mappers.
- Contains: entrypoint `src/client/main.tsx`, router `src/client/router.tsx`, root shell `src/client/root.tsx`, error boundary `src/client/error-boundary.tsx`, route modules under `src/client/routes/`, layout modules under `src/client/layouts/`, client hooks under `src/client/hooks/`, client lib modules under `src/client/lib/`, and client-specific components under `src/client/components/`.
- Key files: `src/client/router.tsx`, `src/client/root.tsx`, `src/client/lib/trpc.ts`, `src/client/lib/providers.tsx`, `src/client/hooks/use-project-snapshot-sync.ts`

**`src/client/routes/`:**
- Purpose: Define page-level UI modules matched by `src/client/router.tsx`.
- Contains: admin route modules under `src/client/routes/admin/`, project list/new/redirect routes under `src/client/routes/projects/`, workspace list/new/detail routes under `src/client/routes/projects/workspaces/`, reviews route `src/client/routes/reviews.tsx`, logs route `src/client/routes/logs.tsx`, and mobile baseline route `src/client/routes/mobile-baseline.tsx`.
- Key files: `src/client/routes/projects/workspaces/detail.tsx`, `src/client/routes/projects/workspaces/list.tsx`, `src/client/routes/projects/workspaces/new.tsx`, `src/client/routes/admin-page.tsx`, `src/client/routes/reviews.tsx`

**`src/components/`:**
- Purpose: Provide reusable UI primitives and feature components shared across routes.
- Contains: UI primitives under `src/components/ui/`, chat components under `src/components/chat/`, workspace panels under `src/components/workspace/`, agent activity renderers under `src/components/agent-activity/`, project forms under `src/components/project/`, layout components under `src/components/layout/`, and shared badges under `src/components/shared/`.
- Key files: `src/components/ui/button.tsx`, `src/components/chat/use-chat-websocket.ts`, `src/components/workspace/terminal-panel.tsx`, `src/components/workspace/workspace-content-view.tsx`, `src/components/layout/resizable-layout.tsx`

**`src/hooks/`:**
- Purpose: Hold cross-client React hooks that are not route-specific.
- Contains: WebSocket transport and viewport/window helpers.
- Key files: `src/hooks/use-websocket-transport.ts`, `src/hooks/use-visual-viewport-height.ts`, `src/hooks/use-is-mobile.ts`

**`src/lib/`:**
- Purpose: Hold frontend/shared utilities that sit outside app routes and backend code.
- Contains: chat protocol facade, WebSocket URL config, utility helpers, diff helpers, and tests.
- Key files: `src/lib/websocket-config.ts`, `src/lib/chat-protocol.ts`, `src/lib/utils.ts`, `src/lib/diff/`

**`src/shared/`:**
- Purpose: Provide framework-neutral contracts shared by backend, client, and package exports.
- Contains: ACP protocol contracts under `src/shared/acp-protocol/`, core enum/status derivation under `src/shared/core/`, schema modules under `src/shared/schemas/`, WebSocket schemas under `src/shared/websocket/`, proxy helpers in `src/shared/proxy-utils.ts`, and workspace derivation helpers.
- Key files: `src/shared/core/index.ts`, `src/shared/acp-protocol/index.ts`, `src/shared/websocket/index.ts`, `src/shared/schemas/factory-config.schema.ts`, `src/shared/schemas/issue-tracker-config.schema.ts`

**`src/cli/`:**
- Purpose: Implement the `ff` command-line interface.
- Contains: command entrypoint, proxy command, database path resolution, runtime utilities, and tests.
- Key files: `src/cli/index.ts`, `src/cli/proxy.ts`, `src/cli/database-path.ts`, `src/cli/runtime-utils.ts`

**`electron/`:**
- Purpose: Implement the Electron wrapper around the web app and backend server.
- Contains: main process modules under `electron/main/` and preload bridge under `electron/preload/`.
- Key files: `electron/main/index.ts`, `electron/main/lifecycle.ts`, `electron/main/server-manager.ts`, `electron/preload/index.ts`

**`prisma/`:**
- Purpose: Define database schema, migrations, and generated Prisma client.
- Contains: schema `prisma/schema.prisma`, migrations under `prisma/migrations/`, generated client under `prisma/generated/`, and Prisma config in `prisma.config.ts`.
- Key files: `prisma/schema.prisma`, `prisma/generated/client.ts`, `prisma/migrations/migration_lock.toml`, `src/backend/db.ts`, `src/backend/migrate.ts`

**`packages/core/`:**
- Purpose: Package extracted core enums and derivation helpers for reuse.
- Contains: package source under `packages/core/src/`, package build output under `packages/core/dist/`, package manifest, and tests.
- Key files: `packages/core/src/index.ts`, `packages/core/src/types/enums.ts`, `packages/core/src/shared/ci-status.ts`, `packages/core/src/shared/workspace-sidebar-status.ts`

**`prompts/`:**
- Purpose: Store runtime markdown prompt templates copied into `dist/prompts/` during build.
- Contains: quick actions under `prompts/quick-actions/`, ratchet prompts under `prompts/ratchet/`, and workflow prompts under `prompts/workflows/`.
- Key files: `prompts/quick-actions/`, `prompts/ratchet/`, `prompts/workflows/`, `src/backend/prompts/markdown-loader.ts`

**`scripts/`:**
- Purpose: Provide validation, build, code generation, and native module support scripts.
- Contains: service ownership checks, import checks, native module setup, generated schema checks, Prisma import fixes, and postinstall scripts.
- Key files: `scripts/check-service-registry.ts`, `scripts/check-single-writer.mjs`, `scripts/check-ambiguous-relative-imports.mjs`, `scripts/ensure-native-modules.mjs`, `scripts/fix-prisma-imports.mjs`

**`docs/`:**
- Purpose: Hold design and project documentation.
- Contains: design docs under `docs/design/`.
- Key files: `docs/design/core-library-extraction/`, `docs/design/factory-factory-cloud-vision/`

**`.planning/`:**
- Purpose: Hold GSD project state, milestones, phases, research, and codebase maps.
- Contains: state file `.planning/STATE.md`, project plan `.planning/PROJECT.md`, phase artifacts under `.planning/phases/`, milestone artifacts under `.planning/milestones/`, and codebase maps under `.planning/codebase/`.
- Key files: `.planning/STATE.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`

## Key File Locations

**Entry Points:**
- `src/client/main.tsx`: Browser React entrypoint.
- `src/client/router.tsx`: React Router route table.
- `src/client/root.tsx`: Root provider/layout composition.
- `src/backend/index.ts`: Standalone backend process entrypoint.
- `src/backend/server.ts`: Express/tRPC/WebSocket server factory.
- `src/cli/index.ts`: CLI command entrypoint.
- `electron/main/index.ts`: Electron main entrypoint.
- `electron/preload/index.ts`: Electron preload API entrypoint.

**Configuration:**
- `package.json`: Scripts, workspace dependency flow, and runtime/dev dependencies.
- `pnpm-workspace.yaml`: pnpm workspace package list.
- `tsconfig.json`: Full TypeScript project config and path aliases.
- `tsconfig.backend.json`: Backend TypeScript build config.
- `tsconfig.electron.json`: Electron TypeScript build config.
- `vite.config.ts`: Vite frontend and dev proxy configuration.
- `vitest.config.ts`: Vitest test configuration.
- `biome.json`: Formatting and linting configuration.
- `.dependency-cruiser.cjs`: Architecture import-boundary rules.
- `components.json`: shadcn/ui component config.
- `tailwind.config.ts`: Tailwind configuration.
- `prisma.config.ts`: Prisma CLI config.
- `electron-builder.yml`: Electron packaging config.
- `.env.example`: Example environment configuration only; do not read or copy secret-bearing `.env` files.

**Core Logic:**
- `src/backend/services/registry.ts`: Service dependency and Prisma ownership registry.
- `src/backend/app-context.ts`: Backend service container and app config construction.
- `src/backend/services/workspace/service/lifecycle/state-machine.service.ts`: Workspace lifecycle state machine.
- `src/backend/services/workspace/resources/workspace.accessor.ts`: Workspace Prisma access.
- `src/backend/services/session/service/lifecycle/session.service.ts`: Agent session lifecycle service.
- `src/backend/services/session/service/acp/`: ACP runtime process/client management.
- `src/backend/services/ratchet/service/ratchet.service.ts`: PR ratchet polling/progression service.
- `src/backend/services/run-script/service/run-script.service.ts`: Workspace run-script lifecycle.
- `src/backend/services/workspace-snapshot-store.service.ts`: In-memory workspace snapshot store.
- `src/backend/orchestration/domain-bridges.orchestrator.ts`: Cross-domain bridge wiring.
- `src/backend/orchestration/workspace-init.orchestrator.ts`: Workspace provisioning workflow.
- `src/backend/orchestration/workspace-archive.orchestrator.ts`: Workspace archive workflow.
- `src/backend/orchestration/event-collector.orchestrator.ts`: Event-to-snapshot coalescing.
- `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`: Authoritative snapshot reconciliation.

**API And Transport:**
- `src/backend/trpc/index.ts`: Root tRPC router.
- `src/backend/trpc/trpc.ts`: tRPC context and helpers.
- `src/backend/trpc/workspace.trpc.ts`: Workspace API procedures.
- `src/backend/trpc/session.trpc.ts`: Session API procedures.
- `src/backend/trpc/project.trpc.ts`: Project API procedures.
- `src/backend/trpc/workspace/files.trpc.ts`: Workspace file API procedures.
- `src/backend/trpc/workspace/git.trpc.ts`: Workspace git API procedures.
- `src/backend/routers/health.router.ts`: HTTP health API.
- `src/backend/routers/websocket/chat.handler.ts`: Chat WebSocket endpoint.
- `src/backend/routers/websocket/terminal.handler.ts`: Terminal WebSocket endpoint.
- `src/backend/routers/websocket/snapshots.handler.ts`: Workspace snapshot WebSocket endpoint.

**Client Data And UI:**
- `src/client/lib/trpc.ts`: Typed tRPC React client.
- `src/client/lib/providers.tsx`: tRPC/React Query/project context provider.
- `src/client/hooks/use-project-snapshot-sync.ts`: Snapshot stream to React Query cache sync.
- `src/client/lib/snapshot-to-sidebar.ts`: Snapshot-to-sidebar data mapper.
- `src/client/lib/snapshot-to-kanban.ts`: Snapshot-to-kanban data mapper.
- `src/components/chat/use-chat-websocket.ts`: Chat WebSocket state/transport composition.
- `src/components/workspace/use-terminal-websocket.ts`: Terminal WebSocket hook.
- `src/hooks/use-websocket-transport.ts`: Generic WebSocket reconnect/queue hook.

**Persistence:**
- `prisma/schema.prisma`: Database schema.
- `prisma/migrations/`: SQL migration history.
- `prisma/generated/`: Generated Prisma client committed for path alias `@prisma-gen/*`.
- `src/backend/db.ts`: Prisma client singleton.
- `src/backend/migrate.ts`: Runtime migration runner.

**Testing:**
- `vitest.config.ts`: Test runner configuration.
- `src/backend/testing/setup.ts`: Backend test setup.
- `src/backend/testing/integration-db.ts`: Integration database helpers.
- `src/test-utils/`: Shared test utilities.
- `e2e/mobile-baseline.spec.ts-snapshots/`: Playwright snapshot artifacts.
- Co-located `*.test.ts` and `*.test.tsx` files next to implementation modules throughout `src/`, `electron/`, and `packages/core/src/`.

## Naming Conventions

**Files:**
- Use `*.service.ts` for backend service classes/singletons and service helpers, such as `src/backend/services/logger.service.ts` and `src/backend/services/session/service/lifecycle/session.service.ts`.
- Use `*.accessor.ts` for Prisma resource accessors, such as `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Use `*.trpc.ts` for tRPC routers, such as `src/backend/trpc/workspace.trpc.ts`.
- Use `*.router.ts` for non-tRPC Express routers, such as `src/backend/routers/health.router.ts`.
- Use `*.handler.ts` for WebSocket endpoint handlers, such as `src/backend/routers/websocket/chat.handler.ts`.
- Use `*.orchestrator.ts` for cross-domain workflow coordinators, such as `src/backend/orchestration/workspace-init.orchestrator.ts`.
- Use `*.schema.ts` for Zod schemas, such as `src/shared/schemas/factory-config.schema.ts` and `src/backend/schemas/tool-inputs.schema.ts`.
- Use `*.test.ts` and `*.test.tsx` for co-located tests; use `*.stories.tsx` for Storybook stories.
- Use lower-kebab filenames for most modules, such as `workspace-derived-state.ts`, `project-scoped.ts`, and `workspace-detail-header.tsx`; existing React component filenames may use PascalCase where already established, such as `WorkspaceNotificationManager.tsx`.

**Directories:**
- Use service capsule directories under `src/backend/services/{name}/` with a required `index.ts` barrel.
- Place service business logic under `src/backend/services/{name}/service/`.
- Place Prisma accessors under `src/backend/services/{name}/resources/`.
- Place page-level React modules under `src/client/routes/` following route nesting.
- Place shared route-independent UI under `src/components/{domain}/`.
- Place neutral shared contracts under `src/shared/{domain}/`.

**Imports:**
- Use `@/*` for `src/` imports.
- Use `@prisma-gen/*` for generated Prisma files under `prisma/generated/`.
- Import backend service capsules from barrels only, such as `@/backend/services/workspace`.
- Keep `src/client/lib/trpc.ts` as the only frontend file importing backend tRPC types from `src/backend/trpc/`.
- Avoid importing from `src/backend/services/index.ts`; use concrete service files or capsule barrels as enforced by `.dependency-cruiser.cjs`.

## Where to Add New Code

**New Backend Domain Feature:**
- Primary code: add or extend the owning service capsule under `src/backend/services/{name}/service/`.
- Public API: export only needed symbols from `src/backend/services/{name}/index.ts`.
- Data access: add Prisma queries to `src/backend/services/{name}/resources/` if the service owns the model.
- Registry: update `src/backend/services/registry.ts` when adding a capsule, service dependency, or Prisma model ownership.
- Tests: place tests next to service files, for example `src/backend/services/{name}/service/{feature}.service.test.ts`.

**New Cross-Domain Workflow:**
- Primary code: add an orchestrator to `src/backend/orchestration/`.
- Bridge pattern: define bridge interfaces in the service capsule that owns the behavior, then wire concrete implementations in `src/backend/orchestration/domain-bridges.orchestrator.ts`.
- API entry: call the orchestrator from `src/backend/trpc/*.trpc.ts` or `src/backend/server.ts` startup only when the workflow crosses domains.
- Tests: add `src/backend/orchestration/{workflow}.orchestrator.test.ts`.

**New tRPC API:**
- Primary code: add procedures to an existing router in `src/backend/trpc/*.trpc.ts` or create a new router file under `src/backend/trpc/`.
- Root registration: add new routers to `appRouter` in `src/backend/trpc/index.ts`.
- Validation: define Zod input schemas in the router or in `src/backend/schemas/` / `src/shared/schemas/` when shared.
- Tests: add `src/backend/trpc/{router}.router.test.ts` or adjacent router tests following existing naming.

**New WebSocket Endpoint:**
- Primary code: add a handler factory under `src/backend/routers/websocket/{name}.handler.ts`.
- Export: add it to `src/backend/routers/websocket/index.ts`.
- Server wiring: add the route to the upgrade switch in `src/backend/server.ts`.
- Client hook: compose `src/hooks/use-websocket-transport.ts` from `src/client/hooks/` or `src/components/{domain}/`.
- Shared schema: place neutral message schemas in `src/shared/websocket/` when both client and backend parse them.

**New Frontend Route:**
- Primary code: add page module under `src/client/routes/` following route nesting.
- Router wiring: register the route in `src/client/router.tsx`.
- Route-local hooks/components: keep route-specific code beside the route under `src/client/routes/...`.
- Shared UI: move reusable pieces to `src/components/{domain}/` only when more than one route/component family needs them.
- Tests: place route tests as `src/client/routes/{route}.test.tsx` or adjacent to the route module.

**New Shared Component:**
- Implementation: add to `src/components/{domain}/` for product components or `src/components/ui/` for design-system primitives.
- Exports: use local `index.ts` barrels where the directory already has one, such as `src/components/chat/index.ts` or `src/components/workspace/index.ts`.
- Stories: add `*.stories.tsx` next to UI components when the component has visual states.
- Tests: add `*.test.tsx` next to components with behavior, state, or accessibility risk.

**New Client Data Helper:**
- tRPC/cache helpers: add to `src/client/lib/`.
- Client hooks: add to `src/client/hooks/` for app-specific hooks or `src/hooks/` for cross-app/client hooks.
- Shared pure helpers: add to `src/lib/` only when they are frontend-safe and not route-specific.

**New Shared Contract Or Schema:**
- Backend/client neutral schemas: add to `src/shared/schemas/`.
- WebSocket payload contracts: add to `src/shared/websocket/`.
- ACP/chat protocol contracts: add to `src/shared/acp-protocol/`.
- Core enum/status derivation: add to `src/shared/core/` and mirror into `packages/core/src/` when it belongs in the exported core package.

**New Prisma Model Or Field:**
- Schema: edit `prisma/schema.prisma`.
- Ownership: update `src/backend/services/registry.ts` for new models.
- Access: add methods in the owning service resource accessor under `src/backend/services/{name}/resources/`.
- Migration: create a migration under `prisma/migrations/`.
- Generated client: run the Prisma generation workflow so `prisma/generated/` stays aligned.

**New CLI Command:**
- Primary code: add command registration in `src/cli/index.ts` or delegate complex logic to a new module under `src/cli/`.
- Runtime helpers: reuse `src/cli/runtime-utils.ts` and `src/cli/database-path.ts`.
- Tests: add `src/cli/{command}.test.ts`.

**New Electron Capability:**
- Main-process code: add to `electron/main/`.
- Browser bridge: expose safe APIs from `electron/preload/index.ts`.
- Shared types: add browser/Electron types under `src/types/`.
- Tests: add `electron/main/{feature}.test.ts` for lifecycle/server behavior.

**New Prompt Template:**
- Markdown template: add to `prompts/quick-actions/`, `prompts/ratchet/`, or `prompts/workflows/`.
- Loader/parser logic: update `src/backend/prompts/`.
- Build behavior: `package.json` copies `prompts/` into `dist/prompts/` during `pnpm build`.

## Special Directories

**`prisma/generated/`:**
- Purpose: Generated Prisma client used by `@prisma-gen/*` alias.
- Generated: Yes.
- Committed: Yes.

**`dist/`:**
- Purpose: Build output for backend, frontend, prompts, and package artifacts.
- Generated: Yes.
- Committed: Present in working tree; treat as build output unless a task explicitly targets packaged artifacts.

**`node_modules/`:**
- Purpose: Installed dependencies.
- Generated: Yes.
- Committed: No.

**`coverage/`:**
- Purpose: Test coverage output.
- Generated: Yes.
- Committed: No.

**`storybook-static/`:**
- Purpose: Static Storybook build output.
- Generated: Yes.
- Committed: No.

**`.native-cache/`:**
- Purpose: Cached native modules for Node/Electron ABI combinations.
- Generated: Yes.
- Committed: No.

**`.factory-factory/`:**
- Purpose: Local Factory Factory runtime artifacts such as screenshots.
- Generated: Yes.
- Committed: Screenshots may be committed when explicitly required by a UI workflow.

**`.planning/`:**
- Purpose: GSD planning artifacts and codebase maps.
- Generated: Partially.
- Committed: Yes.

**`.claude/`:**
- Purpose: Local Claude settings; no `.claude/skills/` project skill index is present.
- Generated: Local configuration.
- Committed: Contains `settings.local.json`; do not rely on it for architecture rules.

**`.agents/`:**
- Purpose: Project agent skill/plugin configuration if present.
- Generated: Not detected.
- Committed: Not detected.

**`prompts/`:**
- Purpose: Runtime prompt templates loaded by backend prompt loaders and copied into production builds.
- Generated: No.
- Committed: Yes.

**`public/`:**
- Purpose: Static frontend assets such as logos and sounds.
- Generated: No.
- Committed: Yes.

---

*Structure analysis: 2026-04-29*
