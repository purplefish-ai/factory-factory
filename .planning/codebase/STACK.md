# Technology Stack

**Analysis Date:** 2026-02-09

## Languages

**Primary:**
- TypeScript 5.9.3 - All backend and frontend code
- JavaScript (ESM) - Runtime via tsx and Node.js

**Supporting:**
- CSS - Styling with Tailwind CSS
- NDJSON - Protocol for Claude CLI bidirectional communication

## Runtime

**Environment:**
- Node.js (no specific version pinned in package.json, uses pnpm 10.28.1)

**Package Manager:**
- pnpm 10.28.1 - Specified in package.json
- Lockfile: `pnpm-lock.yaml` (present)

## Frameworks

**Backend:**
- Express 5.2.1 - HTTP server
- tRPC 11.9.0 - RPC framework (server: @trpc/server, client: @trpc/client, React: @trpc/react-query)
- Prisma 7.3.0 - ORM and schema management

**Frontend:**
- React 19.2.4 - UI framework
- React Router 7.13.0 - Client-side routing
- Vite 7.3.1 - Frontend build tool and dev server
- TanStack React Query 5.90.20 - Data fetching and caching

**UI/Components:**
- shadcn/ui (Radix UI components) - Complete component library via @radix-ui packages
- Tailwind CSS 4.1.18 - Utility-first CSS framework
- React Hook Form 7.71.1 - Form state management
- Zod 4.3.6 - Schema validation

**Real-time Communication:**
- ws (WebSockets) 8.19.0 - WebSocket server and client
- Electron 40.1.0 - Desktop application framework

**Testing & Quality:**
- Vitest 4.0.18 - Unit test runner
- @vitest/coverage-v8 4.0.18 - Code coverage
- Biome 2.3.13 - Linting and formatting
- Storybook 10.2.4 - Component development environment
- supertest 7.2.2 - HTTP assertion library

**Utilities:**
- Zod 4.3.6 - Runtime validation
- superjson 2.2.6 - JSON serialization with type preservation
- date-fns 4.1.0 - Date manipulation
- recharts 3.7.0 - Charts and visualization
- mermaid 11.12.2 - Diagram rendering
- xterm 6.0.0 - Terminal emulation (@xterm/xterm + @xterm/addon-fit)
- react-markdown 10.1.0 - Markdown rendering
- remark-gfm 4.0.1 - GitHub flavored markdown
- rehype-sanitize 6.0.0 - HTML sanitization
- rehype-raw 7.0.0 - Raw HTML support in markdown
- react-syntax-highlighter 16.1.0 - Code highlighting
- embla-carousel-react 8.6.0 - Carousel component
- sonner 2.0.7 - Toast notifications

**CLI & Build:**
- Commander 14.0.3 - CLI argument parsing
- Chalk 5.6.2 - Terminal color output
- node-pty 1.1.0 - Terminal session management
- better-sqlite3 12.6.2 - SQLite database driver (native module)
- @prisma/adapter-better-sqlite3 7.3.0 - Prisma SQLite adapter
- dotenv 17.2.3 - Environment variable loading
- open 11.0.0 - Cross-platform open command

**Development & Build Tools:**
- tsc-alias 1.8.16 - TypeScript path alias resolution
- tsx 4.21.0 - TypeScript execution without compilation
- concurrently 9.2.1 - Run multiple npm scripts concurrently
- electron-rebuild 4.0.3 - Rebuild native modules for Electron
- electron-builder 26.7.0 - Electron app packaging
- postcss 8.5.6 - CSS transformation
- autoprefixer 10.4.24 - CSS vendor prefixing
- husky 9.1.7 - Git hooks
- lint-staged 16.2.7 - Run linters on staged files
- dependency-cruiser 17.3.7 - Architectural boundaries checking
- knip 5.83.0 - Find unused dependencies

**Drag & Drop:**
- @dnd-kit/core 6.3.1 - Headless drag/drop system
- @dnd-kit/sortable 10.0.0 - Sortable functionality
- @dnd-kit/utilities 3.2.2 - Utilities

## Key Dependencies

**Critical Infrastructure:**
- Prisma (ORM) - Database schema and migrations
- better-sqlite3 - SQLite database connection
- Express - HTTP server and API
- tRPC - Type-safe RPC and API communication
- React - Frontend framework

**Communication:**
- ws - WebSocket protocol implementation
- superjson - Type-preserving JSON serialization for tRPC

**Development Quality:**
- Biome - Code formatting and linting (enforced via pre-commit hooks)
- Vitest - Test runner with rapid iteration

## Configuration

**Environment:**
- Loaded via `dotenv` from `.env` file (example in `.env.example`)
- Critical variables: `DATABASE_PATH`, `BACKEND_PORT`, `FRONTEND_PORT`, `NODE_ENV`
- Optional: `BASE_DIR` for worktree storage, `BACKEND_URL` for dev proxy
- Optional: Agent models/permissions: `ORCHESTRATOR_MODEL`, `WORKER_PERMISSIONS`, etc.

**Build Configuration:**
- TypeScript: `tsconfig.json` (main), `tsconfig.backend.json`, `tsconfig.electron.json`
- Vite: `vite.config.ts` - Frontend build, dev server, API proxy
- Biome: `biome.json` - Linting rules, import organization, formatting
- Electron: `electron/main.ts` (built to `dist/`)

**Database:**
- Prisma schema: `prisma/schema.prisma`
- Adapter: `@prisma/adapter-better-sqlite3` for SQLite
- Migrations: `prisma/migrations/`
- Generated client: `prisma/generated/`
- Default database path: `~/factory-factory/data.db` (configurable via `DATABASE_PATH`)

**Git Hooks:**
- Husky integration: `.husky/` directory
- Pre-commit: Runs `biome check --write` on staged files via lint-staged

## Platform Requirements

**Development:**
- Node.js with pnpm 10.28.1
- Native modules require compilation: better-sqlite3, node-pty, @prisma/engines
- Build requires `tsc` and `vite` (installed as dev dependencies)

**Production:**
- Node.js runtime (for CLI/server mode)
- SQLite database file system access
- Electron 40.1.0 for desktop app (includes Chromium, Node.js runtime)
- Native modules built via electron-rebuild for Electron
- Desktop app packages via electron-builder (supports macOS, Windows, Linux)

**Ports:**
- Backend: `BACKEND_PORT` (default 3001 in dev, 4001 in config)
- Frontend: `FRONTEND_PORT` (default 4000 in config, 3000 in dev via Vite)
- WebSocket proxy: `/chat`, `/terminal`, `/dev-logs` endpoints

---

*Stack analysis: 2026-02-09*
