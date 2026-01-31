# Codebase Structure

**Analysis Date:** 2026-01-31

## Directory Layout

```
factory-factory/
├── src/
│   ├── backend/              # Express + tRPC backend
│   │   ├── agents/           # Agent process adapter
│   │   ├── claude/           # Claude CLI integration
│   │   ├── clients/          # External system clients (git)
│   │   ├── constants/        # HTTP/WebSocket constants
│   │   ├── interceptors/     # Tool event interceptors
│   │   ├── lib/              # Utility libraries
│   │   ├── middleware/       # Express middleware
│   │   ├── prompts/          # Prompt template utilities
│   │   ├── resource_accessors/ # Prisma query layer
│   │   ├── routers/          # Route handlers
│   │   │   ├── api/          # REST endpoints
│   │   │   ├── mcp/          # MCP tool handlers
│   │   │   └── websocket/    # WebSocket handlers
│   │   ├── services/         # Business logic services
│   │   ├── trpc/             # tRPC routers
│   │   │   ├── procedures/   # Custom tRPC procedures
│   │   │   └── workspace/    # Workspace sub-routers
│   │   └── utils/            # Utility functions
│   ├── client/               # React SPA entry & routes
│   │   ├── layouts/          # Page layout components
│   │   └── routes/           # Route page components
│   │       └── projects/
│   │           └── workspaces/
│   ├── components/           # Shared React components
│   │   ├── agent-activity/   # Claude activity display
│   │   ├── chat/             # Chat UI components
│   │   ├── layout/           # Layout primitives
│   │   ├── project/          # Project management UI
│   │   ├── shared/           # Cross-feature components
│   │   ├── ui/               # Base UI components (shadcn)
│   │   └── workspace/        # Workspace UI components
│   ├── frontend/             # App-specific frontend code
│   │   ├── components/       # App shell components
│   │   └── lib/              # tRPC client, providers
│   ├── hooks/                # Shared React hooks
│   ├── lib/                  # Shared utilities
│   ├── shared/               # Shared types (frontend + backend)
│   └── cli/                  # CLI entry point
├── electron/                 # Electron desktop wrapper
│   ├── main/                 # Main process
│   └── preload/              # Preload scripts
├── prisma/                   # Database schema & migrations
│   ├── generated/            # Prisma client output
│   └── migrations/           # Migration files
├── prompts/                  # Markdown prompt templates
│   ├── quick-actions/        # Quick action prompts
│   └── workflows/            # Workflow prompts
├── bin/                      # Build output binaries
└── dist/                     # Build output
    ├── client/               # Frontend build
    └── src/                  # Backend build
```

## Directory Purposes

**`src/backend/`:**
- Purpose: All server-side code
- Contains: API routes, services, database access, Claude integration
- Key files: `server.ts` (main), `index.ts` (entry), `db.ts` (Prisma client)

**`src/backend/trpc/`:**
- Purpose: tRPC API definitions
- Contains: Router definitions, procedures, context creation
- Key files: `index.ts` (appRouter), `workspace.trpc.ts`, `project.trpc.ts`, `session.trpc.ts`

**`src/backend/routers/websocket/`:**
- Purpose: WebSocket connection handlers
- Contains: Chat (Claude), terminal (PTY), dev-logs handlers
- Key files: `chat.handler.ts`, `terminal.handler.ts`, `dev-logs.handler.ts`

**`src/backend/resource_accessors/`:**
- Purpose: Database query abstraction
- Contains: Type-safe Prisma wrappers for each model
- Key files: `workspace.accessor.ts`, `project.accessor.ts`, `claude-session.accessor.ts`

**`src/backend/services/`:**
- Purpose: Business logic and cross-cutting concerns
- Contains: Session management, terminal service, scheduling, reconciliation
- Key files: `session.service.ts`, `terminal.service.ts`, `scheduler.service.ts`, `config.service.ts`

**`src/backend/claude/`:**
- Purpose: Claude Code CLI integration
- Contains: Client wrapper, protocol parsing, session file reading
- Key files: `session.ts` (SessionManager), `types.ts`, `protocol.test.ts`

**`src/backend/interceptors/`:**
- Purpose: Tool event side effects
- Contains: Interceptors triggered on Claude tool use
- Key files: `pr-detection.interceptor.ts`, `branch-rename.interceptor.ts`, `registry.ts`

**`src/client/`:**
- Purpose: SPA routes and entry point
- Contains: Page components, layouts, router config
- Key files: `main.tsx`, `router.tsx`, `root.tsx`

**`src/client/routes/`:**
- Purpose: Route page components
- Contains: Home, projects, workspaces, admin pages
- Key files: `home.tsx`, `projects/list.tsx`, `projects/workspaces/detail.tsx`

**`src/components/`:**
- Purpose: Shared React components
- Contains: UI primitives, feature components, storybook stories
- Key files: `ui/*.tsx` (shadcn), `chat/*.tsx`, `workspace/*.tsx`

**`src/components/chat/`:**
- Purpose: Chat interface components
- Contains: Input, message list, session picker, prompts
- Key files: `chat-input.tsx`, `virtualized-message-list.tsx`, `permission-prompt.tsx`

**`src/components/workspace/`:**
- Purpose: Workspace detail UI
- Contains: Panels, file browser, terminal, git views
- Key files: `terminal-panel.tsx`, `file-browser-panel.tsx`, `right-panel.tsx`

**`src/frontend/`:**
- Purpose: App shell and providers
- Contains: tRPC setup, theme, sidebar, header
- Key files: `lib/trpc.ts`, `lib/providers.tsx`, `components/app-sidebar.tsx`

**`src/shared/`:**
- Purpose: Types shared between frontend and backend
- Contains: Shared type definitions
- Key files: `github-types.ts`, `pending-request-types.ts`, `workspace-words.ts`

**`electron/`:**
- Purpose: Desktop app wrapper
- Contains: Main process, preload, server manager
- Key files: `main/index.ts`, `main/server-manager.ts`

**`prompts/`:**
- Purpose: System prompt templates
- Contains: Markdown files for workflows and quick actions
- Key files: `workflows/*.md`, `quick-actions/*.md`

## Key File Locations

**Entry Points:**
- `src/cli/index.ts`: CLI entry point (`ff` command)
- `src/backend/index.ts`: Backend server entry (standalone)
- `src/backend/server.ts`: Server creation and configuration
- `src/client/main.tsx`: Frontend SPA entry
- `electron/main/index.ts`: Electron main process entry

**Configuration:**
- `package.json`: Dependencies, scripts, CLI bin
- `prisma/schema.prisma`: Database schema
- `vite.config.ts`: Vite build configuration
- `tsconfig.json`: TypeScript base config
- `tsconfig.backend.json`: Backend TypeScript config
- `tsconfig.electron.json`: Electron TypeScript config
- `biome.json`: Linting/formatting config

**Core Logic:**
- `src/backend/server.ts`: Server setup, middleware, WebSocket upgrade
- `src/backend/trpc/index.ts`: tRPC router composition
- `src/backend/routers/websocket/chat.handler.ts`: Claude chat handling
- `src/backend/services/session.service.ts`: Claude session lifecycle
- `src/client/router.tsx`: Frontend route definitions

**Testing:**
- `src/backend/**/*.test.ts`: Backend unit tests
- `src/**/*.stories.tsx`: Storybook component stories
- `vitest.config.ts`: Vitest configuration

## Naming Conventions

**Files:**
- `.tsx`: React components
- `.ts`: TypeScript modules
- `.test.ts`: Test files (co-located)
- `.stories.tsx`: Storybook stories (co-located)
- `.accessor.ts`: Resource accessor (database layer)
- `.service.ts`: Service (business logic)
- `.trpc.ts`: tRPC router
- `.handler.ts`: WebSocket handler
- `.router.ts`: Express router
- `.interceptor.ts`: Tool interceptor
- `.mcp.ts`: MCP tool handler

**Directories:**
- Lowercase with hyphens for multi-word
- Feature-based grouping in `components/`
- Layer-based grouping in `backend/`

## Where to Add New Code

**New tRPC Endpoint:**
- Create router in `src/backend/trpc/{feature}.trpc.ts`
- Add to appRouter in `src/backend/trpc/index.ts`
- Add accessor in `src/backend/resource_accessors/` if new queries needed

**New React Page:**
- Create route component in `src/client/routes/{path}.tsx`
- Add route to `src/client/router.tsx`

**New UI Component:**
- Shared: `src/components/{feature}/{component}.tsx`
- App-specific: `src/frontend/components/{component}.tsx`
- Add story: `{component}.stories.tsx` alongside

**New Service:**
- Create in `src/backend/services/{name}.service.ts`
- Export from `src/backend/services/index.ts`

**New WebSocket Handler:**
- Create in `src/backend/routers/websocket/{name}.handler.ts`
- Export from `src/backend/routers/websocket/index.ts`
- Add upgrade handler in `src/backend/server.ts`

**New Database Model:**
- Add to `prisma/schema.prisma`
- Run `pnpm db:migrate` to create migration
- Run `pnpm db:generate` to update Prisma client
- Create accessor in `src/backend/resource_accessors/`

**New Tool Interceptor:**
- Create in `src/backend/interceptors/{name}.interceptor.ts`
- Register in `src/backend/interceptors/index.ts`

## Special Directories

**`prisma/generated/`:**
- Purpose: Generated Prisma client
- Generated: Yes (by `prisma generate`)
- Committed: No (.gitignore)

**`dist/`:**
- Purpose: Build output
- Generated: Yes (by `pnpm build`)
- Committed: No (.gitignore)

**`release/`:**
- Purpose: Electron distributables
- Generated: Yes (by `pnpm build:electron`)
- Committed: No (.gitignore)

**`node_modules/`:**
- Purpose: Dependencies
- Generated: Yes (by `pnpm install`)
- Committed: No (.gitignore)

**`.planning/`:**
- Purpose: Project planning documents
- Generated: No (manual or by GSD commands)
- Committed: Varies by project

---

*Structure analysis: 2026-01-31*
