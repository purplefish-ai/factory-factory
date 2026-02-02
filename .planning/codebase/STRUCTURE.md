# Codebase Structure

**Analysis Date:** 2026-02-01

## Directory Layout

```
factory-factory/
├── src/                         # Main source code (TypeScript)
│   ├── cli/                     # CLI entry point (Node.js executable)
│   ├── backend/                 # Express server, services, database logic
│   ├── frontend/                # React component library and provider setup
│   ├── client/                  # Frontend app entry point, routes, layouts
│   ├── components/              # Shared React components (UI, chat, workspace, layout)
│   ├── hooks/                   # React custom hooks
│   ├── lib/                     # Shared frontend utilities
│   ├── types/                   # Shared TypeScript types
│   └── shared/                  # Shared utilities for both frontend/backend
├── electron/                    # Electron main process and build config
├── prisma/                      # Database schema and migrations
├── prompts/                     # Claude prompts for MCP tools
├── scripts/                     # Build and utility scripts
├── .storybook/                  # Storybook configuration for component development
├── dist/                        # Compiled backend (generated)
└── node_modules/                # Dependencies
```

## Directory Purposes

**`src/cli/`:**
- Purpose: CLI command interface and server startup orchestration
- Contains: Commander.js command definitions, process lifecycle management, port detection
- Key files: `src/cli/index.ts` (main entry point)
- Commands: `serve` (default), help, version

**`src/backend/`:**
- Purpose: Express backend server, tRPC API, WebSocket handlers, business logic
- Contains: Server setup, routers, services, database access
- Subdirectories:
  - `index.ts`: Standalone server entry point (used by CLI)
  - `server.ts`: Server creation function (used by CLI and Electron)
  - `db.ts`: Prisma client singleton and database path resolution
  - `routers/`: Express routers and WebSocket handlers
  - `trpc/`: tRPC router definitions and procedures
  - `services/`: ~35 services for domain logic (session, chat, workspace, etc.)
  - `resource_accessors/`: Database query abstraction layer
  - `claude/`: Claude CLI process client and protocol handling
  - `agents/`: Agent orchestration (process adapter)
  - `clients/`: External clients (Git, GitHub)
  - `middleware/`: Express middleware (auth, logging, CORS, security)
  - `interceptors/`: MCP tool interceptors
  - `schemas/`: Zod validation schemas
  - `lib/`: Backend utilities (git, file, IDE helpers, shell)
  - `prompts/`: Claude prompts for MCP tools
  - `constants/`: Backend constants
  - `utils/`: Utilities (conversation analyzer, etc.)
  - `testing/`: Test utilities

**`src/frontend/`:**
- Purpose: Reusable React components and tRPC/React Query setup
- Contains: Component library, provider configuration
- Subdirectories:
  - `components/`: Radix UI wrappers, custom components (app sidebar, CLI health banner)
  - `lib/`: tRPC client setup, React Query configuration

**`src/client/`:**
- Purpose: Frontend application (Vite entry point for web, Electron renderer)
- Contains: App root, routing, layouts, pages
- Key files:
  - `main.tsx`: React DOM mount point
  - `router.tsx`: React Router v7 configuration
  - `root.tsx`: Root component with providers (tRPC, React Query, Theme)
  - `globals.css`: Global styles
  - `error-boundary.tsx`: Error boundary component
- Subdirectories:
  - `routes/`: Page components (Home, Projects, Workspaces, Admin, Reviews)
  - `layouts/`: Layout components (ProjectLayout, etc.)

**`src/components/`:**
- Purpose: Shared UI and feature components used across pages
- Contains: Rich component library for all features
- Subdirectories:
  - `ui/`: Primitive UI components (Button, Dialog, Input, etc. from Radix UI)
  - `chat/`: Chat-specific components (ChatInput, PermissionPrompt, QuestionPrompt, SessionPicker, SessionTabBar)
  - `workspace/`: Workspace-specific components (FileViewer, Terminal, DiffPanel, WorkflowSelector, etc.)
  - `project/`: Project-specific components (StartupScriptForm, ProjectSettingsDialog)
  - `layout/`: Layout components (ResizableLayout)
  - `agent-activity/`: Agent/message rendering (MessageRenderers, ToolRenderers)
  - `shared/`: Shared utility components (TodoItem)

**`src/hooks/`:**
- Purpose: Reusable React custom hooks
- Contains: WebSocket transport hook, chat persistence hook, chat state management hook

**`src/lib/`:**
- Purpose: Frontend utility functions
- Contains: Shared logic, helpers

**`src/types/`:**
- Purpose: TypeScript type definitions shared between frontend and backend
- Contains: Shared types, interfaces

**`src/shared/`:**
- Purpose: Utilities that work in both frontend and backend contexts
- Contains: Word tokenization, shared helpers

**`electron/`:**
- Purpose: Electron desktop application main process and packaging
- Contains: Main process code, window management, auto-update configuration

**`prisma/`:**
- Purpose: Database schema and migration files
- Key files:
  - `schema.prisma`: Prisma data model (Project, Workspace, ClaudeSession, TerminalSession, DecisionLog, UserSettings, KanbanCard)
  - `migrations/`: Timestamped migration SQL files
  - `generated/`: Prisma client (auto-generated)

**`prompts/`:**
- Purpose: Claude system prompts used by MCP tools
- Contains: Prompt templates for workflow types (refactor, feature, bug-fix, etc.)

**`scripts/`:**
- Purpose: Build, setup, and utility scripts
- Contains: Postinstall hook for native modules, native module validation

**.storybook/`:**
- Purpose: Component development and documentation via Storybook
- Contains: Storybook configuration, theme setup

## Key File Locations

**Entry Points:**
- `src/cli/index.ts`: CLI/standalone server entry point (executable via `npm run dev`)
- `src/backend/index.ts`: Backend server lifecycle (imports `createServer` from server.ts)
- `src/backend/server.ts`: Server factory function (used by CLI and Electron)
- `src/client/main.tsx`: Frontend app entry point (Vite)
- `electron/main.ts` or similar: Electron main process entry (see electron/ directory)

**Configuration:**
- `package.json`: NPM scripts, dependencies
- `tsconfig.json`: TypeScript config with path aliases (`@/*` → `src/`)
- `tsconfig.backend.json`: Backend-specific TS config
- `tsconfig.electron.json`: Electron-specific TS config
- `vite.config.ts`: Vite build configuration for frontend
- `prisma/schema.prisma`: Database schema
- `.env.example`: Environment variable template (check project for actual patterns)
- `electron-builder.yml`: Electron packager configuration

**Core Logic:**
- `src/backend/claude/index.ts`: ClaudeClient - main abstraction for Claude CLI
- `src/backend/services/session.service.ts`: Session lifecycle and ClaudeClient creation
- `src/backend/services/chat-message-handlers.service.ts`: Message dispatch by type
- `src/backend/services/workspace-state-machine.service.ts`: Workspace initialization flow
- `src/backend/routers/websocket/chat.handler.ts`: WebSocket chat connection handler
- `src/backend/routers/websocket/terminal.handler.ts`: WebSocket terminal connection handler
- `src/backend/trpc/index.ts`: tRPC router aggregation
- `src/backend/trpc/workspace.trpc.ts`: Workspace procedures
- `src/backend/trpc/session.trpc.ts`: Session procedures
- `src/client/router.tsx`: Frontend route configuration

**Testing:**
- `src/**/*.test.ts`: Co-located test files
- `vitest.config.ts`: Vitest configuration
- `src/backend/testing/`: Test utilities and fixtures

## Naming Conventions

**Files:**
- Services: `name.service.ts` (e.g., `session.service.ts`, `chat-connection.service.ts`)
- Accessors: `name.accessor.ts` (e.g., `workspace.accessor.ts`)
- Routers: `name.router.ts` (e.g., `health.router.ts`)
- tRPC routers: `name.trpc.ts` (e.g., `workspace.trpc.ts`)
- Handlers: `name.handler.ts` (e.g., `chat.handler.ts`)
- Tests: `name.test.ts` (co-located with source)
- React components: PascalCase in components/ (e.g., `ChatInput.tsx`, `FileViewer.tsx`)
- Hooks: `useNameHook.ts` or `use-name.ts` pattern
- Types: `name.ts` or `name.types.ts`
- Utilities: `name-helper.ts` or `name.ts`

**Directories:**
- Feature directories: lowercase, kebab-case (e.g., `chat-message-handlers`, `workspace-state-machine`)
- Organized by responsibility (services/, routers/, components/) not feature

**TypeScript:**
- Classes: PascalCase (e.g., `ClaudeClient`, `WorkspaceAccessor`)
- Interfaces: PascalCase, prefixed with `I` optional (e.g., `ServerInstance`)
- Types: PascalCase (e.g., `ClaudeClientOptions`)
- Enums: PascalCase (e.g., `WorkspaceStatus`, `SessionStatus`)
- Constants: UPPER_SNAKE_CASE (e.g., `HEARTBEAT_INTERVAL_MS`, `INTERACTIVE_TOOLS`)
- Functions: camelCase (e.g., `createLogger`, `validateWorkingDir`)
- React components: PascalCase (e.g., `ChatInput`, `FileViewer`)

**Import Path Aliases:**
- `@/*` → `src/` (e.g., `@/backend/services`)
- `@prisma-gen/*` → `prisma/generated/` (e.g., `@prisma-gen/client`)

## Where to Add New Code

**New Feature (UI Page + API):**
- API procedure: `src/backend/trpc/{feature}.trpc.ts` (new tRPC router)
- Service logic: `src/backend/services/{feature}.service.ts` or extend existing service
- Database: Update `prisma/schema.prisma` if new model needed, run `pnpm db:migrate`
- React page: `src/client/routes/{feature}/page.tsx` (new route in `src/client/router.tsx`)
- Components: `src/components/{feature}/` (feature-specific components)
- Tests: Co-located `*.test.ts` files

**New Component/UI:**
- UI primitive: `src/components/ui/{ComponentName}.tsx` (Radix wrapped, if generic)
- Feature component: `src/components/{feature}/{ComponentName}.tsx` (if specific to feature)
- Storybook story: `{ComponentName}.stories.tsx` in same directory
- Tests: Co-located `{ComponentName}.test.tsx` or separate test file

**Utilities/Helpers:**
- Frontend: `src/lib/{utility-name}.ts` or `src/{category}/lib/{utility-name}.ts`
- Backend: `src/backend/lib/{utility-name}.ts` or extend existing utility module
- Shared: `src/shared/{utility-name}.ts`

**New Service/Business Logic:**
- Create: `src/backend/services/{name}.service.ts`
- Export from: `src/backend/services/index.ts`
- Initialize in: `src/backend/server.ts` if needs setup, or lazy-initialize in procedures
- Inject: Into tRPC procedures/handlers via import

**New Database Model:**
- Add to: `prisma/schema.prisma`
- Create accessor: `src/backend/resource_accessors/{model}.accessor.ts`
- Export from: `src/backend/resource_accessors/index.ts`
- Migrate: `pnpm db:migrate` and `pnpm db:generate`

**New tRPC Procedure:**
- Add to existing router or create new router file: `src/backend/trpc/{entity}.trpc.ts`
- Use: `publicProcedure` or `projectScopedProcedure` as base
- Expose in: `src/backend/trpc/index.ts` via `appRouter` aggregation
- Test: Co-located `{entity}.trpc.test.ts`

**New WebSocket Endpoint:**
- Add handler: `src/backend/routers/websocket/{feature}.handler.ts`
- Export: From `src/backend/routers/websocket/index.ts`
- Mount: In `src/backend/server.ts` via upgrade handler registration
- Use path: `/api/{feature}` convention

## Special Directories

**`dist/`:**
- Purpose: Compiled backend JavaScript (TypeScript → JavaScript after build)
- Generated: Yes (`npm run build` or `pnpm build`)
- Committed: No (generated artifact, .gitignore'd)
- Contains: Compiled `src/**/*.ts` files, copied `prompts/` directory

**`.next/`:**
- Purpose: Next.js metadata (if any Next.js config detected in plugins)
- Generated: Yes (during type checking or build)
- Committed: No (.gitignore'd)

**`node_modules/`:**
- Purpose: NPM dependencies
- Generated: Yes (`pnpm install`)
- Committed: No (.gitignore'd)

**`.git/`:**
- Purpose: Git repository metadata
- Not modified by application code
- Contains: Git objects, refs, hooks

**`prisma/generated/`:**
- Purpose: Auto-generated Prisma client types
- Generated: Yes (`pnpm db:generate`)
- Committed: No (can regenerate from schema)

---

*Structure analysis: 2026-02-01*
