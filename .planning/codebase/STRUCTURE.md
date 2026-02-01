# Codebase Structure

**Analysis Date:** 2026-02-01

## Directory Layout

```
factory-factory-2/
├── src/                           # Shared source code
│   ├── backend/                   # Backend server (Express + tRPC)
│   │   ├── agents/                # Agent adapters and orchestration
│   │   ├── claude/                # Claude Code protocol and session management
│   │   ├── clients/               # External service clients (git, etc.)
│   │   ├── constants/             # Shared constants and enums
│   │   ├── interceptors/          # Claude protocol interceptors
│   │   ├── lib/                   # Helper utilities (git, files, shell, IDE)
│   │   ├── middleware/            # Express middleware (cors, security, logging)
│   │   ├── prompts/               # Markdown prompt templates
│   │   ├── resource_accessors/    # Data access layer (Prisma queries)
│   │   ├── routers/               # HTTP and WebSocket route handlers
│   │   │   ├── api/               # REST API endpoints
│   │   │   ├── mcp/               # MCP protocol server
│   │   │   └── websocket/         # WebSocket upgrade handlers
│   │   ├── services/              # Business logic services (~34 services)
│   │   ├── testing/               # Test utilities and fixtures
│   │   ├── trpc/                  # tRPC router definitions
│   │   │   ├── procedures/        # Reusable procedure helpers
│   │   │   └── workspace/         # Workspace-scoped procedures
│   │   ├── utils/                 # Backend utilities
│   │   ├── db.ts                  # Prisma client singleton
│   │   ├── index.ts               # Server entry point (CLI mode)
│   │   ├── migrate.ts             # Database migration runner
│   │   └── server.ts              # Server factory and configuration
│   │
│   ├── client/                    # Frontend (React Router)
│   │   ├── routes/                # Page-level route components
│   │   │   ├── projects/          # Project routes (list, create)
│   │   │   │   └── workspaces/    # Workspace routes (list, create, detail)
│   │   │   ├── admin.tsx          # Admin console
│   │   │   ├── home.tsx           # Home page
│   │   │   └── reviews.tsx        # Reviews page
│   │   ├── layouts/               # Layout wrappers (ProjectLayout, etc.)
│   │   ├── error-boundary.tsx     # React error boundary
│   │   ├── main.tsx               # React DOM mount point
│   │   ├── root.tsx               # Root layout component
│   │   └── router.tsx             # Explicit React Router v7 config
│   │
│   ├── components/                # Feature components
│   │   ├── chat/                  # Chat UI and state management
│   │   │   ├── chat-reducer.ts    # Chat message reducer (69KB)
│   │   │   ├── chat-input.tsx     # Message input component
│   │   │   ├── chat-persistence.ts # IndexedDB persistence
│   │   │   ├── permission-prompt.tsx
│   │   │   └── ...
│   │   ├── workspace/             # Workspace UI components
│   │   │   ├── main-view-content.tsx
│   │   │   └── ...
│   │   ├── agent-activity/        # Agent status visualization
│   │   ├── project/               # Project-level components
│   │   ├── shared/                # Shared UI pieces
│   │   └── ui/                    # Radix UI component wrappers
│   │       ├── button.tsx
│   │       ├── dialog.tsx
│   │       ├── dropdown-menu.tsx
│   │       └── ... (59 UI components)
│   │
│   ├── hooks/                     # Custom React hooks
│   │   ├── use-websocket-transport.ts   # WebSocket connection logic
│   │   └── ... (other hooks)
│   │
│   ├── lib/                       # Frontend utilities
│   │   ├── claude-fixtures.ts     # Test fixtures for Claude protocol
│   │   ├── claude-types.ts        # Claude message/block types
│   │   ├── websocket-config.ts    # WebSocket reconnection config
│   │   ├── debug.ts               # Debug utilities
│   │   ├── image-utils.ts         # Image handling
│   │   └── ...
│   │
│   ├── shared/                    # Shared types and utilities
│   │   ├── github-types.ts        # GitHub API types
│   │   ├── pending-request-types.ts
│   │   └── workspace-words.ts     # Workspace word generation utility
│   │
│   ├── types/                     # Shared type definitions
│   ├── components/                # (Legacy - moved to src/components/)
│   ├── frontend/                  # (Legacy - moved to src/client/)
│   └── cli/                       # CLI entry point
│       └── index.ts               # Commander.js CLI implementation
│
├── prisma/                        # Database schema and migrations
│   ├── schema.prisma              # Data model definitions
│   ├── migrations/                # Prisma migrations (auto-generated)
│   └── generated/                 # Prisma client (generated)
│
├── electron/                      # Electron main process
│   └── main.ts                    # (inferred from config)
│
├── .storybook/                    # Storybook configuration
├── prompts/                       # LLM prompt templates (markdown)
├── build-resources/               # Electron build assets
├── bin/                           # Executable scripts
├── biome-rules/                   # Custom Biome linting rules
├── .github/                       # GitHub Actions workflows
├── dist/                          # Build output (generated)
│   ├── src/backend/               # Compiled backend
│   └── client/                    # Built frontend
│
├── vite.config.ts                 # Frontend build config
├── vitest.config.ts               # Test runner config
├── tsconfig.json                  # TypeScript config
├── tsconfig.backend.json          # Backend-specific TS config
├── tsconfig.electron.json         # Electron-specific TS config
├── biome.json                     # Code style and lint config
├── package.json                   # Dependencies and scripts
└── CLAUDE.md                      # Claude Code guidance
```

## Directory Purposes

**src/backend/:**
Home of all server-side logic. Entry point is `index.ts` for CLI or `server.ts` for library usage.

**src/backend/trpc/:**
tRPC router definitions. Each `*.trpc.ts` file defines a domain router (project, workspace, session, admin, etc.). Import routers into `index.ts` to compose the app router.

**src/backend/resource_accessors/:**
All database queries. Import Prisma client from `db.ts`, add queries here. Routers import from this directory.

**src/backend/services/:**
Business logic. Stateful services manage tasks like terminal sessions, chat connections, scheduling, file locking. Singleton instances registered in `index.ts`.

**src/backend/claude/:**
Claude Code protocol implementation. Protocol parser, session manager, permissions check. Used by WebSocket chat handler.

**src/client/routes/:**
Page components. Each file is a top-level route. Nested routes (like workspaces) live in subdirectories. Imported by `router.tsx`.

**src/components/chat/:**
Chat feature: message reducer (Redux-style state machine), input handling, persistence to IndexedDB. Large reducer file (69KB) contains all message handling logic.

**src/components/ui/:**
Radix UI component library wrappers. 59 components including buttons, dialogs, forms, etc. Use these in any feature component.

**prisma/schema.prisma:**
Data model: Project, Workspace, ClaudeSession, TerminalSession, DecisionLog, UserSettings, etc. Run `pnpm db:generate` after changes.

**prompts/:**
Markdown prompt templates used by backend to construct Claude requests. Referenced as file paths at runtime.

## Key File Locations

**Entry Points:**
- `src/cli/index.ts`: CLI commands (serve, build, db:migrate, db:studio)
- `src/backend/index.ts`: Server bootstrap (CLI/standalone mode)
- `src/backend/server.ts`: Server factory, used by Electron
- `src/client/main.tsx`: React app mount point
- `src/client/router.tsx`: React Router v7 configuration

**Configuration:**
- `prisma/schema.prisma`: Data model and relations
- `src/backend/lib/env.ts`: Environment variable parsing
- `src/backend/services/config.service.ts`: Server configuration (ports, paths, env)
- `vite.config.ts`: Frontend build (Vite + React plugin + Tailwind)
- `vitest.config.ts`: Test runner (Node environment, Vitest)
- `tsconfig.json`: TypeScript compiler options

**Core Logic:**
- `src/backend/trpc/workspace.trpc.ts`: Workspace CRUD and operations
- `src/backend/trpc/session.trpc.ts`: Session lifecycle (create, resume, close)
- `src/backend/resource_accessors/workspace.accessor.ts`: Workspace queries
- `src/components/chat/chat-reducer.ts`: Chat state machine (all message types)
- `src/backend/services/terminal.service.ts`: PTY terminal management
- `src/backend/services/session.service.ts`: Session lifecycle management

**Testing:**
- `vitest.config.ts`: Includes src/**/*.test.ts, coverage config
- `src/backend/testing/setup.ts`: Test environment setup
- Example tests: `src/backend/services/workspace-state-machine.service.test.ts`

## Naming Conventions

**Files:**
- Feature components: `feature-name.tsx`
- Services: `service-name.service.ts`
- Accessors: `entity-name.accessor.ts`
- tRPC routers: `domain.trpc.ts`
- Utilities: `name-utils.ts` or `name-helpers.ts`
- Tests: `name.test.ts` (co-located with source)

**Directories:**
- Feature folders: lowercase with hyphens (chat, workspace, agent-activity)
- Backend domains: lowercase (services, routers, resource_accessors)
- Frontend pages: camelCase files in routes/ directory

**Variables & Functions:**
- camelCase for functions, variables, properties
- PascalCase for components, types, interfaces
- UPPER_CASE for constants and enums

## Where to Add New Code

**New Feature (e.g., new workspace operation):**
1. Add tRPC procedure to `src/backend/trpc/workspace.trpc.ts`
2. Add or update query in `src/backend/resource_accessors/workspace.accessor.ts`
3. Add UI component in `src/components/workspace/` or route in `src/client/routes/`
4. Add tests co-located: `workspace.trpc.test.ts`, `workspace-component.test.tsx`

**New Service (e.g., new background job):**
1. Create `src/backend/services/my-service.service.ts`
2. Register singleton in `src/backend/services/index.ts` export
3. Inject into tRPC procedures or WebSocket handlers as needed
4. Add tests: `src/backend/services/my-service.service.test.ts`

**New UI Component:**
- Single component: `src/components/feature/my-component.tsx`
- Part of a library: `src/components/ui/my-component.tsx`
- With Storybook: add `.stories.tsx` alongside

**New Route:**
- Page route: Create file in `src/client/routes/` matching desired path
- Layout wrapper: Create in `src/client/layouts/` and import in route
- Nested route: Create subdirectory in `src/client/routes/`

**New Utility:**
- Backend: `src/backend/lib/` for git/file/IDE helpers or `src/backend/utils/` for general utils
- Frontend: `src/lib/` for frontend-specific helpers
- Shared: `src/shared/` for types or utilities used by both

**New Test:**
- Co-locate with source: `src/backend/services/name.service.test.ts`
- Use setup file: `src/backend/testing/setup.ts` for common fixtures
- Pattern: Test files import from source, not vice versa

## Special Directories

**dist/:**
- Purpose: Compiled output
- Generated: Yes (by TypeScript compiler and Vite)
- Committed: No (in .gitignore)
- Contents: src/backend compiled to dist/src/backend/, frontend build to dist/client/

**node_modules/:**
- Purpose: Dependencies
- Generated: Yes (by pnpm install)
- Committed: No (in .gitignore)

**prisma/migrations/:**
- Purpose: Versioned database schema changes
- Generated: Auto-created by `pnpm db:migrate` (Prisma CLI)
- Committed: Yes - track with git for reproducible deployments

**prisma/generated/:**
- Purpose: Prisma client code (type-safe database client)
- Generated: Yes (by `pnpm db:generate`)
- Committed: No (in .gitignore)

**prompts/:**
- Purpose: LLM prompt templates (markdown files)
- Generated: No (checked in)
- Committed: Yes
- Copied to dist during build (see CLAUDE.md build script)

**build-resources/:**
- Purpose: Electron build icons, installer assets
- Generated: No
- Committed: Yes
- Used by: electron-builder during package step

---

*Structure analysis: 2026-02-01*
