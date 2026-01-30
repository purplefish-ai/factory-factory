# Codebase Structure

**Analysis Date:** 2026-01-29

## Directory Layout

```
/Users/adeeshaekanayake/Programming/FactoryFactory/FactoryFactory/
├── src/
│   ├── backend/               # Express + tRPC API server
│   │   ├── index.ts           # Server entry point
│   │   ├── db.ts              # Prisma client singleton
│   │   ├── agents/            # Claude CLI process management
│   │   ├── claude/            # Claude integration (protocol, session, types)
│   │   ├── clients/           # Git client factory
│   │   ├── interceptors/      # Git operation hooks
│   │   ├── resource_accessors/# Database query layer
│   │   ├── routers/           # API endpoints (REST, MCP)
│   │   ├── services/          # Business logic services
│   │   ├── trpc/              # tRPC router definitions
│   │   ├── lib/               # Backend utilities
│   │   ├── prompts/           # Prompt templates
│   │   └── testing/           # Test utilities
│   ├── client/                # React frontend (Vite)
│   │   ├── main.tsx           # DOM entry point
│   │   ├── router.tsx         # React Router v7 config
│   │   ├── root.tsx           # Root layout wrapper
│   │   ├── error-boundary.tsx # Error fallback
│   │   ├── globals.css        # Tailwind styles
│   │   ├── routes/            # Page components
│   │   │   ├── home.tsx
│   │   │   ├── admin.tsx
│   │   │   ├── reviews.tsx
│   │   │   └── projects/      # Project management pages
│   │   ├── layouts/           # Shared layouts
│   │   └── lib/               # Frontend utilities
│   ├── cli/                   # CLI entry point (Node.js)
│   │   └── index.ts           # Commander setup, process orchestration
│   ├── components/            # Shared React components
│   │   ├── ui/                # Base UI primitives (Radix + Tailwind)
│   │   ├── chat/              # Chat components
│   │   ├── workspace/         # Workspace-specific components
│   │   ├── agent-activity/    # Agent status displays
│   │   ├── kanban/            # Kanban board
│   │   ├── layout/            # Layout components
│   │   └── project/           # Project-related components
│   ├── lib/                   # Shared utilities
│   │   ├── claude-types.ts    # Claude protocol types
│   │   ├── claude-fixtures.ts # Mock data for testing
│   │   ├── queue-storage.ts   # In-memory queue
│   │   └── websocket-config.ts# WebSocket client config
│   ├── shared/                # Cross-platform utilities
│   │   ├── github-types.ts    # GitHub API types
│   │   └── workspace-words.ts # Fun workspace name generator
│   ├── frontend/              # Legacy frontend folder (minimal use)
│   ├── hooks/                 # React custom hooks
│   └── [other]/
├── electron/                  # Electron desktop app
│   ├── main/                  # Main process
│   │   ├── index.ts           # Window creation
│   │   └── server-manager.ts  # Backend lifecycle
│   └── preload/               # Renderer preload (security)
├── prisma/                    # Database schema & migrations
│   ├── schema.prisma          # Data model
│   ├── migrations/            # Migration history
│   └── generated/             # Generated Prisma client (gitignored)
├── public/                    # Static assets
├── docs/                      # Documentation
│   ├── architecture/          # Design docs
│   └── [other topics]/
├── prompts/                   # AI prompts for workflows
│   ├── workflows/             # Workflow-specific prompts
│   └── quick-actions/         # Quick action templates
├── .planning/                 # GSD planning artifacts
│   └── codebase/              # Codebase analysis (this file)
├── .storybook/                # Storybook config
├── .husky/                    # Git hooks
├── .github/                   # GitHub workflows
├── package.json               # Dependencies & scripts
├── tsconfig.json              # TypeScript config
├── vite.config.ts             # Vite build config
├── prisma/schema.prisma       # Data schema
└── CLAUDE.md                  # Development guide for Claude Code
```

## Directory Purposes

**src/backend:**
- Purpose: Express API server with tRPC RPC layer
- Contains: Routers, services, database accessors, middleware
- Key files: `index.ts` (server start), `db.ts` (Prisma), `trpc/index.ts` (router tree)

**src/backend/trpc:**
- Purpose: Type-safe RPC procedure definitions
- Contains: Domain-specific routers (project, workspace, session, admin, prReview, decisionLog)
- Pattern: Each `.trpc.ts` file exports a router, combined in `index.ts`

**src/backend/services:**
- Purpose: Stateful business logic services (singletons)
- Contains: Session management, terminal PTY, Git integration, scheduling, file locking, logging
- Key services: `sessionService`, `terminalService`, `githubCLIService`, `schedulerService`

**src/backend/resource_accessors:**
- Purpose: Centralized database query layer
- Contains: Prisma queries wrapped in type-safe methods
- Pattern: Static accessor objects (workspace, project, claudeSession, terminalSession, decisionLog)

**src/backend/claude:**
- Purpose: Claude CLI integration
- Contains: Protocol parser, session manager, permissions validator, type definitions
- Key files: `index.ts` (ClaudeClient), `protocol.ts` (message parsing), `session.ts` (lifecycle)

**src/backend/interceptors:**
- Purpose: Hook into git operations
- Contains: Decorators for shell command execution (PR detection, branch rename)
- Pattern: Registry applies interceptors before/after git commands

**src/backend/agents:**
- Purpose: Process adapter for spawning and communicating with Claude CLI
- Contains: Child process spawning, pipe setup, IPC protocol
- File: `process-adapter.ts` - adapts node child_process to Claude needs

**src/client:**
- Purpose: React frontend (Vite + React Router v7)
- Contains: Routes, layouts, page components, API client
- Key: `router.tsx` explicitly defines React Router route tree

**src/client/routes:**
- Purpose: Top-level page components
- Contains: `home.tsx`, `admin.tsx`, `reviews.tsx`, `projects/` (nested routes)
- Pattern: Each file is a route handler with its own data fetching

**src/components:**
- Purpose: Shared React components (UI + domain-specific)
- Contains: Chat UI, terminal display, workspace list, kanban board, primitives
- Subdirs: `ui/` (Radix-based primitives), `chat/` (streaming messages), `workspace/` (workspace-specific), `kanban/` (kanban board)

**src/lib:**
- Purpose: Shared utilities and type definitions
- Contains: Claude protocol types, fixtures, queue storage, WebSocket config
- Usage: Both backend and frontend import from here

**src/shared:**
- Purpose: Cross-platform utilities
- Contains: GitHub type definitions, workspace name generator
- No dependencies outside of Zod/types

**prisma:**
- Purpose: Database schema and migrations
- `schema.prisma`: Defines Project, Workspace, ClaudeSession, TerminalSession, DecisionLog models
- `migrations/`: Historical schema changes
- `generated/`: Generated Prisma client (not committed)

**electron:**
- Purpose: Desktop app wrapper
- `main/index.ts`: Creates BrowserWindow, manages app lifecycle
- `main/server-manager.ts`: Spawns backend process, manages lifecycle
- `preload/index.ts`: Security boundary between main and renderer

## Key File Locations

**Entry Points:**
- `src/backend/index.ts`: Backend server (Express + tRPC + WebSocket)
- `src/client/main.tsx`: Frontend DOM root
- `src/cli/index.ts`: CLI command handler
- `electron/main/index.ts`: Electron app window creation

**Configuration:**
- `tsconfig.json`: TypeScript, path aliases (`@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`)
- `vite.config.ts`: Frontend build config
- `prisma/schema.prisma`: Data model
- `package.json`: Dependencies, scripts, build config
- `CLAUDE.md`: Development guide

**Core Logic:**
- `src/backend/trpc/`: API procedures (workspace, project, session operations)
- `src/backend/services/`: Business logic (session management, git, scheduling)
- `src/backend/resource_accessors/`: Database queries
- `src/backend/claude/`: Claude CLI integration
- `src/client/routes/`: Pages and layouts

**Testing:**
- `*.test.ts` files co-located with implementation
- Test config: `vitest` (no separate config file, uses defaults)
- Coverage: `vitest run --coverage`

## Naming Conventions

**Files:**
- Services: `*.service.ts` (e.g., `session.service.ts`)
- Accessors: `*.accessor.ts` (e.g., `workspace.accessor.ts`)
- tRPC routers: `*.trpc.ts` (e.g., `workspace.trpc.ts`)
- Tests: `*.test.ts` co-located with source
- Components: `PascalCase.tsx` (e.g., `KanbanBoard.tsx`)
- Pages: `index.tsx` in route directory (e.g., `src/client/routes/projects/new.tsx`)
- Types: `*-types.ts` or inline interfaces
- Utils: `*.ts` lowercase with hyphen (e.g., `queue-storage.ts`)

**Directories:**
- Plural for collections: `routes/`, `services/`, `components/`
- Singular for single exports: `backend/`, `client/`
- PascalCase for feature domains: `KanbanBoard/`, `ChatSession/` (in components)

**Exports:**
- Service singletons: `const serviceName = ...` exported from `services/index.ts`
- Accessors: `export const workspaceAccessor = { ... }` exported from `resource_accessors/`
- Types: Exported from same file or `*-types.ts`
- Barrel files: `index.ts` re-exports from directory

## Where to Add New Code

**New Feature (full stack):**
- tRPC procedure: `src/backend/trpc/[domain].trpc.ts` - add to appRouter in `index.ts`
- Service logic: `src/backend/services/[feature].service.ts` - export from `services/index.ts`
- Database queries: `src/backend/resource_accessors/[entity].accessor.ts`
- Frontend page: `src/client/routes/[path]/index.tsx`
- Frontend components: `src/components/[domain]/[component].tsx`
- Tests: Co-locate `*.test.ts` next to implementation
- Shared types: `src/lib/` if Claude/shared, `src/shared/` if cross-platform

**New Component/Module:**
- UI primitive: `src/components/ui/[component].tsx` (Radix-based)
- Domain component: `src/components/[domain]/[component].tsx`
- Use Storybook: `[component].stories.tsx` in same directory
- Tests: `[component].test.ts` co-located

**Utilities:**
- Backend: `src/backend/lib/[util].ts`
- Frontend: `src/frontend/lib/[util].ts` (or shared from `src/lib/`)
- Shared: `src/lib/` (for types/constants used everywhere)

**Shared Code:**
- Type definitions: `src/lib/[feature]-types.ts`
- Constants: `src/lib/[feature].ts` or `src/shared/`
- Fixtures: `src/lib/[feature]-fixtures.ts`

## Special Directories

**prisma/generated:**
- Purpose: Generated Prisma client
- Generated: Yes (by `prisma generate`)
- Committed: No (gitignored)
- Regenerate: After schema changes via `pnpm db:generate`

**dist:**
- Purpose: Compiled output (backend only, frontend goes to build/)
- Generated: Yes (by `pnpm build`)
- Committed: No (gitignored)

ction: Generated Vite build output
- Generated: Yes (by `vite build`)
- Committed: No (gitignored)

**node_modules:**
- Purpose: Dependencies
- Generated: Yes (by `pnpm install`)
- Committed: No (gitignored)

**.next:**
- Purpose: Unused (Next.js config in tsconfig, but project uses Vite)
- Generated: Yes (if Next.js runs)
- Committed: No (gitignored)
- Note: Safe to delete if cluttering your workspace

**prompts/:**
- Purpose: AI prompt templates for workflows
- `workflows/`: Workflow-specific prompts (e.g., implementation, testing)
- `quick-actions/`: Quick command templates

---

*Structure analysis: 2026-01-29*
