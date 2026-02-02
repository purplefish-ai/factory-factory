# Technology Stack

**Analysis Date:** 2026-02-01

## Languages

**Primary:**
- TypeScript 5.9.3 - Main language for backend, frontend, CLI, and Electron
- JavaScript - Build scripts and configuration files (tsx/mjs)

**Secondary:**
- CSS/Tailwind - Styling (via @tailwindcss/postcss 4.1.18)
- SQL - SQLite queries via Prisma ORM

## Runtime

**Environment:**
- Node.js 18+ (via pnpm)
- Electron 40.1.0 - Desktop application wrapper

**Package Manager:**
- pnpm 10.28.1 (pinned in package.json)
- Lockfile: pnpm-lock.yaml (committed)

## Frameworks

**Core Backend:**
- Express 5.2.1 - HTTP server
- tRPC 11.9.0 - Type-safe RPC framework (@trpc/server, @trpc/client, @trpc/react-query)
- Prisma 7.3.0 - ORM with SQLite adapter (@prisma/adapter-better-sqlite3)

**Frontend:**
- React 19.2.4 - UI framework
- React Router 7.13.0 - Client routing
- Vite 7.3.1 - Frontend build tool and dev server

**Testing:**
- Vitest 4.0.18 - Unit/integration test runner
- @vitest/coverage-v8 4.0.18 - Code coverage
- supertest 7.2.2 - HTTP endpoint testing

**Build/Development:**
- tsx 4.21.0 - TypeScript execution/dev runtime
- tsc-alias 1.8.16 - Path alias resolution for builds
- concurrently 9.1.0 - Parallel command execution
- wait-on 9.0.3 - Port waiting (Electron dev)
- Storybook 10.2.3 - Component development UI

**Desktop:**
- electron-builder 26.7.0 - Electron app packaging
- @electron/rebuild 4.0.2 - Native module rebuilding

## Key Dependencies

**Critical Backend:**
- better-sqlite3 12.6.2 - SQLite3 C++ bindings (native module)
- node-pty 1.1.0 - Terminal emulation (native module, for workspaces)
- ws 8.19.0 - WebSocket server for real-time chat and terminal sessions

**Frontend UI Components:**
- @radix-ui/* (25+ components) - Headless accessible UI components
- recharts 3.7.0 - Charts/data visualization
- lucide-react 0.563.0 - Icon library (563+ icons)
- sonner 2.0.7 - Toast notifications
- embla-carousel-react 8.6.0 - Carousel component

**Frontend Forms & Validation:**
- react-hook-form 7.71.1 - Form state management
- @hookform/resolvers 5.2.2 - Schema validation adapters
- zod 4.3.6 - TypeScript schema validation

**Frontend State Management:**
- @tanstack/react-query 5.90.20 - Server state synchronization
- superjson 2.2.6 - JSON serialization for complex types

**Terminal & Text:**
- @xterm/xterm 6.0.0 - Terminal emulator UI
- @xterm/addon-fit 0.11.0 - Terminal auto-fit plugin
- react-syntax-highlighter 16.1.0 - Code highlighting
- react-markdown 10.1.0 - Markdown rendering
- remark-gfm 4.0.1 - GitHub Flavored Markdown plugin

**Utilities:**
- commander 14.0.3 - CLI argument parsing
- chalk 5.6.2 - Terminal color output
- dotenv 17.2.3 - Environment variable loading
- date-fns 4.1.0 - Date utilities
- p-limit 7.2.0 - Promise concurrency control
- pidusage 4.0.1 - Process resource monitoring
- open 11.0.0 - Open external URLs/files
- clsx 2.1.1 - CSS class utility
- tailwind-merge 3.4.0 - Tailwind CSS conflict resolution
- mermaid 11.12.2 - Diagram rendering

**Development Tools:**
- @biomejs/biome 2.3.13 - Linting and formatting (Rust-based)
- husky 9.1.7 - Git hooks
- lint-staged 16.2.7 - Run checks on staged files
- knip 5.82.1 - Unused dependency detection
- dependency-cruiser 17.3.7 - Dependency graph validation

**Electron-Specific:**
- Electron main process uses Express server and WebSocket directly

## Configuration

**Environment:**
- `.env.example` - Template for configuration (checked in)
- Environment variables drive database path, ports, Claude model selection, permissions, logging
- Key vars: `DATABASE_PATH`, `BACKEND_PORT`, `FRONTEND_PORT`, `NODE_ENV`, `BASE_DIR`, `WORKTREE_BASE_DIR`
- Claude models: `ORCHESTRATOR_MODEL`, `SUPERVISOR_MODEL`, `WORKER_MODEL` (sonnet, opus, haiku options)
- Rate limiting: `CLAUDE_RATE_LIMIT_PER_MINUTE`, `CLAUDE_RATE_LIMIT_PER_HOUR`, `MAX_SESSIONS_PER_WORKSPACE`

**Build:**
- `tsconfig.json` - Base TypeScript config (ES2022, strict mode enabled)
- `tsconfig.backend.json` - Backend-specific config (extends base)
- `tsconfig.electron.json` - Electron main process config (not in scope for this analysis)
- `vite.config.ts` - Frontend Vite config with path aliases, WebSocket proxying
- `vitest.config.ts` - Test config with v8 coverage, setupFiles
- `biome.json` - Linting/formatting (Rust-based tool, replaces ESLint + Prettier)
- `tailwind.config.ts` - Tailwind CSS configuration
- `postcss.config.mjs` - PostCSS plugins (@tailwindcss/postcss)
- `.dependency-cruiser.cjs` - Dependency validation
- `electron-builder.yml` - Electron packaging config (not shown but referenced)

**TypeScript Compiler Options:**
- Target: ES2022
- Module: ESNext with bundler resolution
- Strict mode: Enabled (noImplicitAny, strictNullChecks, strictFunctionTypes, etc.)
- JSX: react-jsx
- Paths: `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`

## Platform Requirements

**Development:**
- Node.js 18+ (pnpm requirement)
- pnpm 10.28.1
- Platform support: macOS, Windows, Linux (Electron cross-platform)
- Python 3 (for better-sqlite3 and node-pty compilation)
- C++ compiler (for native modules: better-sqlite3, node-pty)

**Production:**
- Node.js runtime (18+)
- SQLite3 system library (for better-sqlite3)
- Libc/GLIBC for native modules
- Electron: Chromium runtime included in distributable
- Git (for operations: `git worktree`, PR operations via `gh` CLI)

**Native Modules (build time):**
- better-sqlite3 - Requires compilation
- node-pty - Requires compilation
- sharper, esbuild, protobufjs - Also compiled (listed in pnpm.onlyBuiltDependencies)

---

*Stack analysis: 2026-02-01*
