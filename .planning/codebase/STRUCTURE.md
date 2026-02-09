# Codebase Structure

**Analysis Date:** 2026-02-09

## Directory Layout

```
factory-factory-3/
├── src/
│   ├── backend/                    # Express + tRPC server
│   │   ├── trpc/                   # tRPC router definitions
│   │   ├── services/               # Business logic services
│   │   ├── resource_accessors/     # Database access layer
│   │   ├── routers/                # HTTP and WebSocket routers
│   │   │   ├── api/                # REST API routers
│   │   │   ├── websocket/          # WebSocket handlers
│   │   │   └── mcp/                # MCP (Model Context Protocol) tools
│   │   ├── middleware/             # Express middleware
│   │   ├── domains/                # Domain-specific logic (single-writer boundaries)
│   │   ├── claude/                 # Claude SDK integration and process management
│   │   ├── clients/                # External API clients (GitHub, etc)
│   │   ├── agents/                 # Agent-related utilities
│   │   ├── lib/                    # Backend utilities
│   │   ├── types/                  # Backend-only types
│   │   ├── constants/              # Backend constants
│   │   ├── schemas/                # Zod schemas for validation
│   │   ├── prompts/                # Prompt templates
│   │   ├── testing/                # Test utilities
│   │   ├── interceptors/           # Interceptors (likely auth/logging)
│   │   ├── app-context.ts          # DI container with all services
│   │   ├── db.ts                   # Prisma client singleton
│   │   ├── index.ts                # CLI entry point wrapper
│   │   └── server.ts               # Server creation and lifecycle
│   ├── client/                     # React frontend
│   │   ├── routes/                 # Page components (React Router)
│   │   ├── layouts/                # Layout wrappers
│   │   ├── router.tsx              # Router definition
│   │   ├── root.tsx                # Root layout component
│   │   ├── main.tsx                # React DOM mount point
│   │   └── error-boundary.tsx      # Error boundary component
│   ├── frontend/                   # Frontend utilities and hooks
│   │   ├── lib/                    # Frontend services (tRPC client, providers)
│   │   ├── components/             # Layout components (sidebar, etc)
│   │   └── hooks/                  # React hooks
│   ├── components/                 # Shared UI components (shadcn/ui)
│   │   ├── ui/                     # Base UI components (buttons, dialogs, etc)
│   │   ├── workspace/              # Workspace-specific components
│   │   ├── chat/                   # Chat UI components
│   │   ├── agent-activity/         # Agent activity indicators
│   │   ├── project/                # Project components
│   │   ├── layout/                 # Layout components
│   │   └── shared/                 # Shared components
│   ├── hooks/                      # Shared React hooks
│   ├── lib/                        # Shared utilities
│   │   ├── diff/                   # Diff parsing and rendering
│   │   └── *.ts                    # Various utilities (formatters, image utils, etc)
│   ├── shared/                     # Shared backend/frontend code
│   │   ├── schemas/                # Zod schemas used by both
│   │   ├── claude/                 # Claude-related shared types
│   │   ├── websocket/              # WebSocket message types
│   │   └── *.ts                    # Shared utilities (status derivation, etc)
│   ├── cli/                        # Command-line interface
│   │   └── index.ts                # CLI entry point
│   └── types/                      # Top-level shared types
├── prisma/
│   ├── schema.prisma               # Database schema
│   ├── migrations/                 # Database migrations
│   └── generated/                  # Prisma-generated types
├── electron/                       # Electron main process wrapper
├── prompts/                        # Prompt templates (copied to dist on build)
├── dist/                           # Build output (generated)
├── node_modules/                   # Dependencies
├── .planning/                      # GSD planning documents
├── .storybook/                     # Storybook configuration
├── package.json                    # Dependencies and scripts
├── tsconfig.json                   # TypeScript configuration
├── biome.json                      # Biome formatter/linter config
├── vite.config.ts                  # Vite build configuration
├── vitest.config.ts                # Vitest test configuration
└── prisma.schema                   # Prisma database schema location
```

## Directory Purposes

**src/backend/trpc/:**
- Purpose: tRPC router definitions (RPC endpoint contracts)
- Contains: One file per router (`workspace.trpc.ts`, `session.trpc.ts`, etc.) plus `trpc.ts` (tRPC setup)
- Key files: `index.ts` aggregates all routers into `appRouter`
- Pattern: Each router file exports `export const {name}Router = router({...})`

**src/backend/services/:**
- Purpose: Business logic orchestration, state management, and complex workflows
- Contains: Service classes that use accessors and other services to implement domain logic
- Key services:
  - `session.service.ts`: Start/stop Claude sessions, manage lifecycle
  - `workspace-creation.service.ts`: Create workspace with git worktree, startup script
  - `workspace-state-machine.service.ts`: Enforce valid workspace state transitions
  - `git-ops.service.ts`: Git operations (clone, pull, push, branch management)
  - `ratchet.service.ts`: Auto-fix PR monitoring and fixes
  - `terminal.service.ts`: Terminal/PTY process management

**src/backend/resource_accessors/:**
- Purpose: Type-safe database queries and mutations
- Contains: One accessor per Prisma model (or logical group)
- Key accessors:
  - `workspace.accessor.ts`: Workspace CRUD, queries by project/status/column
  - `claude-session.accessor.ts`: Session CRUD, session data
  - `project.accessor.ts`: Project CRUD, retrieval
  - `terminal-session.accessor.ts`: Terminal session management
  - `user-settings.accessor.ts`: User settings CRUD
- Pattern: Methods follow naming like `findById()`, `create()`, `update()`, `delete()`, `findByProjectId()`

**src/backend/routers/api/:**
- Purpose: HTTP RESTful endpoints (non-tRPC)
- Contains: Express Router instances
- Key routers:
  - `health.router.ts`: Health check endpoints
  - `project.router.ts`: Project file tree and metadata
  - `mcp.router.ts`: MCP (Model Context Protocol) endpoints

**src/backend/routers/websocket/:**
- Purpose: WebSocket message handling and event routing
- Contains: Upgrade handlers that manage persistent WebSocket connections
- Key handlers:
  - `chat.handler.ts`: Chat message routing for sessions
  - `terminal.handler.ts`: Terminal output streaming
  - `dev-logs.handler.ts`: Development log streaming

**src/backend/routers/mcp/:**
- Purpose: MCP tool definitions for Claude integration
- Contains: MCP server and tool implementations
- Key files: `terminal.mcp.ts`, `lock.mcp.ts`, `system.mcp.ts`

**src/backend/middleware/:**
- Purpose: Express middleware for cross-cutting concerns
- Contains: CORS, logging, security middleware
- Always mounted in `server.ts` before routers

**src/backend/claude/:**
- Purpose: Claude SDK integration, process lifecycle management
- Contains: Process adapters, session managers, client wrappers
- Key files:
  - `session.ts`: SessionManager class for unified client lifecycle
  - `process-adapter.ts`: Adapter for spawning Claude process
  - `registry.ts`: Registry of active processes

**src/client/routes/:**
- Purpose: Page components (React Router routes)
- Structure: Nested by route path
  - `home.tsx`: Home/dashboard page
  - `projects/list.tsx`: Projects list page
  - `projects/new.tsx`: Create new project page
  - `projects/workspaces/list.tsx`: Workspaces list/board page
  - `projects/workspaces/detail.tsx`: Single workspace detail page
  - `admin/`: Admin settings pages
  - `reviews/`: PR review page

**src/components/:**
- Purpose: Shared UI components (shadcn/ui base components + custom)
- Categories:
  - `ui/`: Base components (Button, Dialog, Input, etc) from shadcn/ui
  - `workspace/`: Workspace-specific components (status badges, control panels)
  - `chat/`: Chat interface components
  - `agent-activity/`: Activity indicators and progress displays
  - `layout/`: Resizable panels, headers

**src/shared/:**
- Purpose: Code used by both backend and frontend
- Contains:
  - `schemas/`: Zod validation schemas
  - `websocket/`: WebSocket message type definitions
  - `claude/`: Claude-related types
  - Utility functions: `workspace-sidebar-status.ts`, `ci-status.ts`, etc

**src/lib/:**
- Purpose: Shared utility functions
- Key files:
  - `diff/`: Diff parsing and rendering (unified diff format)
  - `formatters.ts`: Text formatting utilities
  - `utils.ts`: General utilities
  - `debug.ts`: Debug logging helpers
  - `paste-utils.ts`: Clipboard utilities
  - `image-utils.ts`: Image processing

**src/frontend/lib/:**
- Purpose: Frontend-specific integrations and providers
- Key files:
  - `trpc.ts`: tRPC client setup with headers for project/task context
  - `providers.tsx`: TRPC and QueryClient setup

**prisma/:**
- Purpose: Database schema and migrations
- Contains:
  - `schema.prisma`: Prisma schema (defines models, enums, relations)
  - `migrations/`: Timestamped migration files
  - `generated/`: Auto-generated Prisma client and types (do not edit)

**electron/:**
- Purpose: Electron main process wrapper
- Used when running as desktop app instead of web
- Manages window lifecycle, backend server lifecycle

**prompts/:**
- Purpose: Prompt templates for Claude interactions
- Contains: YAML/markdown files with system prompts for agents
- Copied to `dist/prompts` on build for production

## Key File Locations

**Entry Points:**
- `src/backend/index.ts`: CLI server entry point (imports server.ts, starts server)
- `src/backend/server.ts`: Express server creation and configuration
- `src/cli/index.ts`: CLI command-line interface (executable)
- `src/client/main.tsx`: React DOM mount point
- `src/client/router.tsx`: Router definition with all routes
- `electron/main.ts`: Electron main process (if running as desktop app)

**Configuration:**
- `src/backend/app-context.ts`: DI container with all services
- `src/backend/db.ts`: Prisma client singleton
- `src/backend/services/config.service.ts`: Configuration from environment variables
- `tsconfig.json`: TypeScript compiler options and path aliases (`@/*` → `src/*`)

**Core Logic:**
- `src/backend/services/workspace-creation.service.ts`: Workspace initialization
- `src/backend/services/session.service.ts`: Session lifecycle management
- `src/backend/services/git-ops.service.ts`: Git operations
- `src/backend/services/ratchet.service.ts`: Auto-fix PR workflow

**Testing:**
- `src/backend/testing/`: Test utilities and fixtures
- Test files co-located with source: `*.test.ts`, `*.spec.ts`
- Config: `vitest.config.ts`

## Naming Conventions

**Files:**
- Backend services: `{name}.service.ts`
- Accessors: `{entity}.accessor.ts`
- tRPC routers: `{domain}.trpc.ts`
- HTTP routers: `{resource}.router.ts`
- WebSocket handlers: `{feature}.handler.ts`
- Components: `{ComponentName}.tsx`
- Hooks: `use{HookName}.ts`
- Tests: `{name}.test.ts` or `{name}.spec.ts`
- Utilities: `{name}-utils.ts` or `{name}.ts`
- Types: `{name}.ts` or `{name}.types.ts`

**Directories:**
- Lowercase with hyphens: `src/backend/resource_accessors/`, `src/client/routes/`
- PascalCase for components: `src/components/WorkspaceCard/`
- Features grouped: `src/backend/routers/{api,websocket,mcp}/`

**Exports:**
- Services: `export const {serviceName}Service = new ServiceClass(...)`
- Routers: `export const {name}Router = router({...})`
- Accessors: `export const {entity}Accessor = {...}`
- Utilities: `export function name() {...}` or `export const name = ...`

## Where to Add New Code

**New Feature (tRPC Endpoint):**
1. Define Zod schema in `src/backend/schemas/` or inline in router
2. Create service in `src/backend/services/{feature}.service.ts` if complex logic needed
3. Create accessor if new database access pattern needed: `src/backend/resource_accessors/{entity}.accessor.ts`
4. Add procedure to tRPC router: `src/backend/trpc/{domain}.trpc.ts`
5. Add React hooks/components in `src/client/routes/` or `src/components/`
6. Add tests: `src/backend/services/{feature}.service.test.ts`, route tests in same directory

**New React Component:**
1. Shared UI component: `src/components/{Category}/{ComponentName}.tsx`
2. Page component: `src/client/routes/{path}/{ComponentName}.tsx`
3. Layout component: `src/components/layout/{ComponentName}.tsx`
4. Add to Storybook if suitable: `.storybook/stories/`

**New Service:**
- Location: `src/backend/services/{name}.service.ts`
- Register in: `src/backend/app-context.ts` (add to `AppServices` type and `createServices()`)
- Inject via: Constructor dependency injection or singleton pattern

**New Accessor:**
- Location: `src/backend/resource_accessors/{entity}.accessor.ts`
- Export in: `src/backend/resource_accessors/index.ts`
- Used by: Services only (never directly from routers)

**New Database Model:**
1. Add to `prisma/schema.prisma`
2. Run `pnpm db:generate` to generate Prisma client
3. Create migration: `pnpm db:migrate`
4. Create accessor: `src/backend/resource_accessors/{entity}.accessor.ts`
5. Create service if needed

**Utilities:**
- Shared (both backend/frontend): `src/shared/` or `src/lib/`
- Backend only: `src/backend/lib/`
- Frontend only: `src/frontend/lib/`

**Validation Schemas:**
- Shared: `src/shared/schemas/{name}.ts`
- Backend-only: `src/backend/schemas/{name}.ts`

## Special Directories

**src/backend/domains/:**
- Purpose: Optional domain-specific bounded contexts with single-writer boundaries
- Current use: Session domain with write serialization
- Pattern: Enforce that only one operation on a domain can happen at a time
- Example: `sessionStoreService` in `src/backend/domains/session/`
- When to use: When you need strict concurrency control or domain isolation

**src/backend/claude/:**
- Purpose: Claude SDK integration layer
- Generated on build: Not version controlled
- Reset on each start: Process state doesn't persist
- Coordinates: Process spawning, message routing, lifecycle

**prompts/:**
- Purpose: Prompt templates loaded at runtime
- Deployment: Copied to `dist/prompts` in production build
- Structure: YAML frontmatter + markdown prompt body
- Quick actions: `prompts/quick-actions/` for workspace quick actions

**dist/:**
- Generated: Build output, not committed
- Contents: Compiled TypeScript, bundled frontend, copied prompts
- Build command: `pnpm build`

**prisma/generated/:**
- Generated: `pnpm db:generate` command
- Never edit: Overwritten on each generation
- Contains: Prisma client, enums, types

