# Codebase Structure

**Analysis Date:** 2026-02-09

## Directory Layout

```
factory-factory-3/
├── src/                         # Source code root
│   ├── backend/                 # Express server, tRPC, services, database
│   ├── client/                  # React SPA
│   ├── cli/                     # Command-line interface
│   ├── components/              # Shared React UI components
│   ├── frontend/                # Frontend utilities, hooks, providers
│   ├── hooks/                   # Global React hooks
│   ├── lib/                     # Shared utilities, helpers, types
│   ├── shared/                  # Shared code between backend/frontend
│   ├── test-utils/              # Testing utilities
│   └── types/                   # TypeScript type definitions
├── prisma/                      # Database schema and migrations
│   ├── schema.prisma            # Prisma schema definition
│   ├── migrations/              # SQL migration files
│   └── generated/               # Generated Prisma client
├── electron/                    # Electron main process
├── prompts/                     # Prompt templates (copied to dist on build)
├── docs/                        # Documentation
├── public/                      # Static assets
├── scripts/                     # Build and utility scripts
├── .storybook/                  # Storybook configuration
├── .github/                     # GitHub Actions workflows
├── biome-rules/                 # Custom Biome linter rules
└── tsconfig.*.json              # TypeScript configurations
```

## Directory Purposes

**src/backend/**
- Purpose: Server-side logic, APIs, services, database access
- Contains: Express routes, tRPC procedures, WebSocket handlers, services, interceptors, middleware
- Key files: `index.ts` (entry point), `server.ts` (server creation), `app-context.ts` (service locator)

**src/backend/routers/**
- Purpose: HTTP/RPC endpoint definitions
- Contains: API routers (health, mcp, project), WebSocket upgrade handlers, tRPC routers
- Subdirectories: `api/` (Express routes), `websocket/` (chat, terminal, dev-logs handlers), `mcp/` (MCP tools)

**src/backend/routers/api/**
- Purpose: Express HTTP endpoint handlers
- Contains: Health check endpoint, MCP configuration endpoint, project management endpoint
- Key files: `health.router.ts`, `mcp.router.ts`, `project.router.ts`

**src/backend/routers/websocket/**
- Purpose: WebSocket upgrade handlers and message dispatchers
- Contains: Chat handler, terminal handler, dev-logs handler
- Key files: `chat.handler.ts` (session chat), `terminal.handler.ts` (shell execution), `dev-logs.handler.ts` (log streaming)

**src/backend/routers/mcp/**
- Purpose: Model Context Protocol tools integration
- Contains: MCP tool server, tool definitions, resource providers
- Used by: Claude sessions to invoke external tools

**src/backend/services/**
- Purpose: Business logic, state management, external integrations
- Contains: 30+ service files for different concerns (session, workspace, git, GitHub, terminal, scheduler, etc.)
- Pattern: Each service exports a singleton instance and public methods
- Key services:
  - `session.service.ts`: Claude session lifecycle and client management
  - `workspace-creation.service.ts`: Workspace initialization and git setup
  - `chat-event-forwarder.service.ts`: Claude client event routing to WebSocket
  - `chat-message-handlers.service.ts`: Message type dispatching
  - `terminalService`: PTY management and shell execution
  - `ratchetService`: Auto-fix PR monitoring and agent orchestration
  - `github-cli.service.ts`: GitHub API integration via CLI

**src/backend/domains/**
- Purpose: Domain-specific logic and state management
- Contains: Session domain service
- Key files: `src/backend/domains/session/session-domain.service.ts` (session event emission, Claude event tracking)

**src/backend/resource_accessors/**
- Purpose: Encapsulated data access to specific domain entities
- Contains: Accessor classes for workspace, project, session, user settings, decision log
- Pattern: Static methods that return Prisma queries or constructed objects
- Key files: `workspace.accessor.ts`, `claude-session.accessor.ts`, `project.accessor.ts`

**src/backend/trpc/**
- Purpose: tRPC router definitions and procedures
- Contains: Router definitions for project, workspace, session, admin, GitHub, PR review, decision log, user settings
- Key files: `index.ts` (main router), `trpc.ts` (tRPC init), `workspace.trpc.ts`, `session.trpc.ts`
- Pattern: Each router in dedicated file, procedures grouped by entity type

**src/backend/trpc/procedures/**
- Purpose: Reusable tRPC procedure middleware and helpers
- Contains: Project-scoped procedure factory

**src/backend/trpc/workspace/**
- Purpose: Workspace-related tRPC nested routers
- Contains: Init router, files router, git router, IDE router, run-script router

**src/backend/middleware/**
- Purpose: Express middleware for cross-cutting concerns
- Contains: CORS, request logging, security headers
- Key files: `cors.middleware.ts`, `request-logger.middleware.ts`, `security.middleware.ts`

**src/backend/interceptors/**
- Purpose: Event interceptors for domain logic side effects
- Contains: Branch rename, conversation rename, PR detection interceptors
- Key files: `registry.ts` (interceptor registration), `branch-rename.interceptor.ts`, `pr-detection.interceptor.ts`

**src/backend/schemas/**
- Purpose: Zod validation schemas
- Contains: Tool input schemas, WebSocket message schemas
- Key files: `tool-inputs.schema.ts` (Claude tool validation), `websocket/` (chat message types)

**src/backend/constants/**
- Purpose: Runtime constants and configuration
- Contains: Port defaults, environment mode checks, workspace status, session status constants

**src/backend/utils/**
- Purpose: Utility functions for backend logic
- Contains: Git helpers, error handling helpers, validation utilities

**src/backend/lib/**
- Purpose: Supporting libraries and utilities
- Contains: Event emitter type helpers, logger utilities

**src/backend/claude/**
- Purpose: Claude API client integration
- Contains: Client initialization, event types, request handling
- Key files: `index.ts` (ClaudeClient), `types/` (type definitions)

**src/backend/agents/**
- Purpose: Agent execution and lifecycle management
- Contains: Process adapter for agent execution

**src/client/**
- Purpose: React Single Page Application
- Contains: Routes, layouts, components, hooks specific to frontend
- Key files: `main.tsx` (entry point), `router.tsx` (route definitions), `root.tsx` (root layout)

**src/client/routes/**
- Purpose: Route components matching URL paths
- Contains: Page components for projects, workspaces, admin, reviews
- Structure: Mirrors URL structure (projects/, admin.tsx, reviews.tsx)
- Key files: `projects/list.tsx`, `projects/new.tsx`, `projects/workspaces/detail.tsx`

**src/client/layouts/**
- Purpose: Layout components for route groups
- Contains: Project layout wrapper
- Key files: `project-layout.tsx` (wraps all project-scoped routes)

**src/frontend/lib/**
- Purpose: Frontend utilities and configuration
- Contains: TRPC configuration, providers, workspace cache helpers
- Key files: `trpc.ts` (tRPC client setup), `providers.tsx` (TRPC and React Query provider)

**src/frontend/hooks/**
- Purpose: Frontend React hooks for data fetching and side effects
- Contains: Workspace creation hook, workspace attention hook
- Key files: `use-create-workspace.ts`, `use-workspace-attention.ts`

**src/frontend/components/**
- Purpose: Frontend-specific components (not shared)
- Contains: App sidebar, CLI health banner, theme provider, etc.

**src/components/**
- Purpose: Shared reusable UI components
- Contains: Chat UI, workspace components, project components, layouts, UI primitives (buttons, dialogs, etc.)
- Subdirectories: `chat/` (chat interface), `workspace/` (workspace management UI), `project/` (project UI), `ui/` (shadcn/ui components), `layout/` (layout primitives)
- Pattern: Component + Storybook story + tests co-located

**src/hooks/**
- Purpose: Global React hooks
- Contains: Custom hooks for common patterns

**src/lib/**
- Purpose: Shared utility functions and helpers
- Contains: Claude type definitions, formatting utilities, image processing, paste utilities
- Key files: `claude-types.ts`, `formatters.ts`, `image-utils.ts`, `diff/` (diff utilities)

**src/shared/**
- Purpose: Code shared between backend and frontend
- Contains: Claude type definitions, WebSocket message types, workspace utilities
- Subdirectories: `claude/` (shared Claude types), `schemas/` (shared validation), `websocket/` (message types)

**src/test-utils/**
- Purpose: Testing utilities and helpers
- Contains: Mock factories, test fixtures, setup utilities

**prisma/**
- Purpose: Database schema and migrations
- Contains: Prisma schema definition, SQL migration files, generated Prisma client
- Key files: `schema.prisma` (entity definitions and enums), `migrations/` (numbered SQL migrations)
- Generated: `generated/client` (Prisma client, regenerated on schema changes)

**electron/**
- Purpose: Electron main process
- Contains: Window management, IPC handlers, backend process lifecycle
- Key files: `main.ts` (entry point), `server-manager.ts` (backend subprocess management)

**prompts/**
- Purpose: Claude prompt templates
- Contains: Prompt templates for agents, quick actions
- Build: Copied to `dist/prompts/` on build

**docs/**
- Purpose: Project documentation
- Contains: Architecture docs, feature docs, API docs

**.storybook/**
- Purpose: Storybook configuration and decorators
- Contains: Storybook main config, preview config, theme setup

**scripts/**
- Purpose: Build and utility scripts
- Contains: Postinstall setup, native module handling, build helpers

## Key File Locations

**Entry Points:**
- CLI: `src/cli/index.ts` - Command-line interface
- Backend Server: `src/backend/index.ts` - Standalone server entry
- Frontend: `src/client/main.tsx` - React root
- Electron: `electron/main.ts` - Desktop app entry

**Configuration:**
- TypeScript Backend: `tsconfig.backend.json`
- TypeScript Electron: `tsconfig.electron.json`
- Vite Frontend: `vite.config.ts`
- Biome Linting: `.biome.jsonc` (project root)
- Storybook: `.storybook/main.ts`

**Core Logic:**
- tRPC Main Router: `src/backend/trpc/index.ts`
- tRPC Workspace Procedures: `src/backend/trpc/workspace.trpc.ts`
- tRPC Session Procedures: `src/backend/trpc/session.trpc.ts`
- Session Service: `src/backend/services/session.service.ts`
- Workspace Creation: `src/backend/services/workspace-creation.service.ts`
- Chat Event Forwarder: `src/backend/services/chat-event-forwarder.service.ts`
- Message Handlers: `src/backend/services/chat-message-handlers.service.ts`

**Testing:**
- Test Utils: `src/test-utils/`
- Backend Tests: Alongside source files (*.test.ts)
- Test Config: `vitest.config.ts`

## Naming Conventions

**Files:**
- Services: `{name}.service.ts` - Business logic and state management
- Accessors: `{entity}.accessor.ts` - Data access for specific entities
- Handlers: `{type}.handler.ts` - Request/event handlers
- Routers: `{entity}.{router-type}.ts` - tRPC routers (workspace.trpc.ts, session.router.ts)
- Middleware: `{name}.middleware.ts` - Express middleware
- Interceptors: `{name}.interceptor.ts` - Event interceptors
- Tests: `{name}.test.ts` or `{name}.spec.ts` - Test files
- Components: `{PascalCase}.tsx` - React components
- Utilities: `{name}-utils.ts` or `{name}.utils.ts` - Helper functions
- Types: `{name}.ts` - Type definitions, `{name}-types.ts` for type-focused files
- Schemas: `{name}.schema.ts` - Zod validation schemas

**Directories:**
- Feature directories: `lowercase` with hyphens (e.g., `chat-message-handlers/`)
- Component directories: `lowercase` (e.g., `kanban/`, `layout/`)
- Index files required for barrel exports

**Functions:**
- camelCase for all function names
- Service methods: instance methods or static methods on singleton
- React components: PascalCase file names matching export
- Hooks: `use{Name}` pattern for React hooks

**Variables:**
- camelCase for local variables, parameters
- SCREAMING_SNAKE_CASE for constants
- PascalCase for React component exports

**Types:**
- PascalCase for all type names
- Interface names should indicate structure (e.g., `WorkspaceAccessor`)
- Use discriminated unions in Zod schemas (see workspace creation source)

## Where to Add New Code

**New Feature (Workspace-scoped):**
- Primary code: `src/backend/services/{feature-name}.service.ts`
- TRPC procedures: `src/backend/trpc/workspace/{feature-name}.trpc.ts`
- Data access: Add methods to `src/backend/resource_accessors/workspace.accessor.ts` or create `{entity}.accessor.ts`
- Tests: `src/backend/services/{feature-name}.service.test.ts`

**New Component/Module:**
- Shared component: `src/components/{category}/{ComponentName}.tsx`
- Feature component: `src/client/routes/{path}/components/{ComponentName}.tsx`
- Associated styles: Component file includes Tailwind classes
- Storybook story: `{ComponentName}.stories.tsx` alongside component

**New Service:**
- Location: `src/backend/services/{name}.service.ts`
- Pattern: Export singleton instance and public methods
- Register in: `src/backend/app-context.ts` AppServices type and createServices function
- Example: See `sessionService`, `terminalService`

**Utilities:**
- Shared helpers: `src/lib/{category}/{name}-utils.ts`
- Backend-only: `src/backend/utils/{name}-utils.ts`
- Frontend-only: `src/frontend/lib/{name}.ts`

**Validation Schemas:**
- Tool inputs: `src/backend/schemas/tool-inputs.schema.ts`
- WebSocket messages: `src/backend/schemas/websocket/{type}.schema.ts`
- Shared schemas: `src/shared/schemas/`

**Types & Interfaces:**
- Shared types: `src/shared/{category}/{name}-types.ts`
- Backend types: `src/backend/types/{name}.ts`
- Claude types: `src/lib/claude-types.ts` for shared, `src/backend/claude/types/` for backend-only

**Tests:**
- Unit tests: Alongside source file (`{name}.test.ts`)
- Integration tests: In same directory with clear naming
- Test setup: Use utilities from `src/test-utils/`

## Special Directories

**src/backend/testing/**
- Purpose: Testing framework setup and utilities
- Generated: No
- Committed: Yes
- Contains: Test database setup, helper functions

**dist/**
- Purpose: Compiled output from TypeScript and Vite
- Generated: Yes (during `pnpm build`)
- Committed: No
- Structure: Mirrors src/ structure, includes compiled JS and React bundle

**node_modules/**
- Purpose: Installed dependencies
- Generated: Yes (via pnpm install)
- Committed: No

**prisma/generated/client/**
- Purpose: Generated Prisma client (auto-generated from schema)
- Generated: Yes (via `pnpm db:generate`)
- Committed: No
- Regenerate: Run `pnpm db:generate` after schema changes

**.planning/**
- Purpose: Planning documents (generated by GSD commands)
- Generated: Yes (by gsd:map-codebase)
- Committed: Yes
- Contains: Architecture analysis, structure mapping, testing patterns, concerns

**biome-rules/**
- Purpose: Custom Biome linter rules
- Generated: No
- Committed: Yes
- Used: Referenced in .biome.jsonc configuration

**public/**
- Purpose: Static assets served by Vite or Express
- Generated: No
- Committed: Yes
- Contains: Favicon, logos, images

---

*Structure analysis: 2026-02-09*
