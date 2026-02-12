# Codebase Structure

**Analysis Date:** 2026-02-10

## Directory Layout

```
project-root/
├── src/
│   ├── backend/              # Express + tRPC server (Node.js)
│   ├── client/               # React client routes and root (Vite)
│   ├── frontend/             # Reusable React components + hooks (shared UI)
│   ├── components/           # shadcn/ui + feature component groups
│   ├── lib/                  # Shared utilities (diff, formatters, types, fixtures)
│   ├── shared/               # Shared schemas, types, utilities (both backend/frontend)
│   ├── hooks/                # Shared React hooks
│   ├── cli/                  # CLI entrypoint and command handlers
│   ├── types/                # TypeScript type definitions (global)
│   └── test-utils/           # Test fixtures and helpers
├── prisma/
│   ├── schema.prisma         # Prisma schema (SQLite models)
│   ├── migrations/           # Prisma migration files
│   └── generated/            # Prisma client (generated, gitignored)
├── electron/                 # Electron main process wrapper (optional)
│   ├── main/                 # Electron main process
│   └── preload/              # Preload scripts
├── public/                   # Static assets (sounds, icons)
├── scripts/                  # Utility scripts
├── docs/                     # Documentation
├── prompts/                  # Prompt templates for agents
├── biome-rules/              # Biome linter custom rules
├── .github/workflows/        # GitHub Actions CI/CD
├── .planning/codebase/       # GSD planning documents (this dir)
├── vite.config.ts            # Vite frontend build config
├── tsconfig.json             # TypeScript config
├── package.json              # Dependencies + build scripts
└── .env, .env.local          # Environment config (SECRET: never commit)
```

## Directory Purposes

**`src/backend/`:**
- Purpose: Express HTTP server, tRPC API layer, business logic services
- Contains: Routers, services, resource accessors, database client, middleware
- Key files: `index.ts` (standalone), `server.ts` (library), `app-context.ts` (DI container)
- Subdirectories:
  - `trpc/`: tRPC route handlers, context setup (entrypoint: `index.ts`, `trpc.ts`)
  - `services/`: 85+ business logic services (session, workspace, github, scheduler, etc.)
  - `resource_accessors/`: Prisma query abstractions (workspace, project, session, etc.)
  - `claude/`: Claude SDK integration (session manager, protocol, permissions, process registry)
  - `routers/`: REST/WebSocket route handlers (api/, mcp/, websocket/)
  - `middleware/`: Express middleware (CORS, security, logging)
  - `interceptors/`: tRPC interceptors
  - `lib/`: Shared backend utilities (git helpers, env, logger, etc.)
  - `domains/`: Domain-driven logic (session domain)
  - `schemas/`: Zod validation schemas
  - `types/`: TypeScript type definitions (ServerInstance, Context, etc.)
  - `testing/`: Test fixtures and mocks
  - `agents/`: Process adapter for Claude agent spawning

**`src/client/`:**
- Purpose: React application routing, root layout
- Contains: React Router config, root page layout
- Key files:
  - `main.tsx`: React app entry point (mounts to `#root`)
  - `router.tsx`: React Router configuration with all routes
  - `root.tsx`: Root layout wrapper
  - `error-boundary.tsx`: Error boundary component
  - `globals.css`: Global styles
- Subdirectories:
  - `routes/`: Page components (home, projects, workspaces, admin, logs, reviews)
  - `layouts/`: Layout wrappers (ProjectLayout)

**`src/frontend/`:**
- Purpose: Reusable React components and hooks shared across routes
- Contains: Feature-specific component groups, hooks, utilities, tRPC client setup
- Key files:
  - `lib/trpc.ts`: tRPC client initialization (`createTrpcClient`, `getBaseUrl`)
  - `lib/providers.tsx`: React Query + tRPC provider setup
- Subdirectories:
  - `components/`: Feature components (app-sidebar, kanban, chat, workspace, data-import, etc.)
  - `hooks/`: Custom React hooks

**`src/components/`:**
- Purpose: Base UI component library and feature-specific components
- Contains: shadcn/ui wrapper components, complex feature components
- Subdirectories:
  - `ui/`: shadcn/ui components (Button, Card, Dialog, Input, etc.)
  - `chat/`: Chat UI components (message, input, stream)
  - `workspace/`: Workspace detail components
  - `agent-activity/`: Agent activity display
  - `shared/`: Shared UI utilities
  - `layout/`: Layout components
  - `project/`: Project-specific UI
  - `data-import/`: Data import UI

**`src/lib/`:**
- Purpose: Shared backend/frontend utility functions and types
- Contains: Type definitions (claude types, fixtures), utility functions (formatters, paste-utils, diff)
- Key files:
  - `claude-types.ts`: TypeScript types for Claude API responses
  - `claude-fixtures.ts`: Test fixtures for Claude messages
  - `formatters.ts`: Code formatting helpers
  - `paste-utils.ts`: Clipboard and paste handling utilities
  - `image-utils.ts`: Image embedding/encoding
  - `websocket-config.ts`: WebSocket configuration constants

**`src/shared/`:**
- Purpose: Shared schemas, types, and utilities for both backend and frontend
- Contains: Zod schemas, TypeScript types, utility functions
- Key files:
  - `ci-status.ts`: CI status derivation logic
  - `workspace-sidebar-status.ts`: Workspace status display logic
  - `workspace-words.ts`: Workspace naming utilities
  - `github-types.ts`: GitHub API response types
  - `session-runtime.ts`: Session runtime utilities
  - `websocket/`: WebSocket message types
  - `schemas/`: Zod validation schemas
  - `claude/`: Claude-specific shared logic

**`src/hooks/`:**
- Purpose: Shared React hooks
- Contains: Custom hooks for state management, effects, events

**`src/cli/`:**
- Purpose: Command-line interface entry point
- Contains: CLI command handlers, server/frontend process management
- Key file: `index.ts` (entire CLI implementation)
- Handles: `pnpm dev`, `pnpm start`, database setup, port finding, graceful shutdown

**`prisma/`:**
- Purpose: Database schema and migrations
- Key files:
  - `schema.prisma`: Prisma schema (defines all models, enums, indexes)
  - `migrations/`: Auto-generated migration files (one per schema change)
  - `generated/`: Prisma client (auto-generated, `.gitignore`d)
- Models: Project, Workspace, ClaudeSession, TerminalSession, DecisionLog, UserSetting

**`electron/`:**
- Purpose: Electron main process (desktop app wrapper, optional)
- Subdirectories:
  - `main/`: Electron main process code (window management, IPC)
  - `preload/`: Preload scripts for main/renderer isolation

**`public/`:**
- Purpose: Static assets served by HTTP server
- Contains: Sounds, icons, images
- Subdirectories: `sounds/` (notification sounds)

**`prompts/`:**
- Purpose: Prompt templates for agent sessions
- Subdirectories: `quick-actions/` (markdown-driven quick action prompts), `ratchet/`, `workflows/`

## Key File Locations

**Entry Points:**
- `src/cli/index.ts`: CLI entrypoint (dev/start commands)
- `src/backend/index.ts`: Standalone backend server
- `src/backend/server.ts::createServer()`: Backend server factory (used by Electron)
- `src/client/main.tsx`: React app mount point
- `electron/main/index.ts`: Electron main process (if present)

**Configuration:**
- `vite.config.ts`: Frontend build + dev server config
- `tsconfig.json`: TypeScript compiler config
- `package.json`: Dependencies, scripts, workspace config
- `prisma/schema.prisma`: Database schema
- `.env`, `.env.local`: Environment variables (secrets, paths)

**Core Logic:**
- `src/backend/app-context.ts`: AppContext DI container, all services instantiated
- `src/backend/db.ts`: Prisma client singleton, database connection
- `src/backend/trpc/index.ts`: tRPC app router composition
- `src/backend/services/session.service.ts`: Session lifecycle management
- `src/backend/claude/session.ts`: Claude SDK session spawning
- `src/frontend/lib/providers.tsx`: React Query + tRPC provider setup

**Testing:**
- `src/**/*.test.ts`, `src/**/*.spec.ts`: Test files (Vitest)
- `src/test-utils/`: Test utilities and fixtures
- `vitest.config.ts`: Vitest configuration (if present)

## Naming Conventions

**Files:**
- Services: `{domain}.service.ts` (e.g., `session.service.ts`, `ratchet.service.ts`)
- Accessors: `{domain}.accessor.ts` (e.g., `workspace.accessor.ts`, `project.accessor.ts`)
- Routes: `{domain}.trpc.ts` (e.g., `workspace.trpc.ts`, `session.trpc.ts`)
- Components: `{component-name}.tsx` (e.g., `app-sidebar.tsx`, `kanban-board.tsx`)
- Tests: `{file}.test.ts` or `{file}.spec.ts` (co-located or in `__tests__/`)
- Utils: `{function-name}-utils.ts` or `{domain}-helpers.ts` (e.g., `paste-utils.ts`, `git-helpers.ts`)

**Directories:**
- Feature groups: kebab-case (e.g., `chat-message-handlers`, `agent-activity`)
- Services: plural noun (e.g., `services/`, `routers/`, `resource_accessors/`)
- Domain layers: `domains/{domain-name}/`

## Where to Add New Code

**New Feature:**
- Primary code: `src/backend/services/` (business logic)
  - Create `src/backend/services/{feature}.service.ts`
  - Export singleton instance at bottom of file
  - Import into `src/backend/app-context.ts::createServices()`
- Backend routing: `src/backend/trpc/{feature}.trpc.ts`
  - Create procedures using `publicProcedure` or custom procedures
  - Add to `appRouter` in `src/backend/trpc/index.ts`
- Frontend UI: `src/frontend/components/{feature}/` or `src/client/routes/{feature}/`
  - Use tRPC hooks: `trpc.{feature}.{action}.useQuery()` or `.useMutation()`
- Database: Update `prisma/schema.prisma`, run `pnpm db:migrate create add_{feature}`

**New Component/Module:**
- Reusable UI component: `src/components/{group}/{component-name}.tsx` or `src/frontend/components/`
- shadcn/ui wrapper: `src/components/ui/{component}.tsx` (copy from shadcn CLI)
- Feature-specific container: `src/frontend/components/{feature}/`
- Route page: `src/client/routes/{feature}/` or nested subdirectories

**Utilities:**
- Backend-only: `src/backend/lib/{name}-helpers.ts`
- Frontend-only: `src/frontend/lib/{name}-utils.ts`
- Shared: `src/lib/{name}-utils.ts` (both can import)
- Types: `src/lib/{name}-types.ts`
- Schemas: `src/shared/schemas/{name}.ts` (Zod)

**Tests:**
- Co-locate with source: `src/{path}/{file}.test.ts` next to source
- Or dedicated test directory: `src/{path}/__tests__/{file}.test.ts`
- Run via `pnpm test` (Vitest), `pnpm test:watch` (watch mode)

## Special Directories

**`.planning/codebase/`:**
- Purpose: GSD codebase mapping documents
- Generated: By `/gsd:map-codebase` command
- Committed: Yes (design artifacts)
- Contents: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, STACK.md, INTEGRATIONS.md, CONCERNS.md

**`prisma/migrations/`:**
- Purpose: Database migration history
- Generated: By `pnpm db:migrate create` command
- Committed: Yes (must track for consistency)
- Each migration is a `.sql` file with timestamp prefix

**`prisma/generated/`:**
- Purpose: Prisma client code (generated)
- Generated: By `pnpm db:generate` command
- Committed: No (in `.gitignore`)
- Regenerate after schema changes: `pnpm db:generate`

**`dist/`, `build/`:**
- Purpose: Build outputs
- Generated: By `pnpm build` command
- Committed: No (in `.gitignore`)
- Frontend: Vite output to `dist/`
- Backend: TypeScript output to `build/` or similar

**`.env`, `.env.local`:**
- Purpose: Environment configuration
- Generated: Manually by user
- Committed: No (in `.gitignore`)
- Required vars: `DATABASE_PATH`, `BACKEND_PORT`, `FRONTEND_STATIC_PATH`, `NODE_ENV`, GitHub CLI auth

---

*Structure analysis: 2026-02-10*
