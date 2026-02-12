# Technology Stack

**Analysis Date:** 2026-02-10

## Languages

**Primary:**
- TypeScript 5.9.3 - Full stack (backend, frontend, CLI, Electron)

**Secondary:**
- JavaScript (Node.js runtime for CLI, Electron main process)
- CSS (Tailwind CSS 4.1.18)

## Runtime

**Environment:**
- Node.js (version not pinned; package.json specifies pnpm@10.28.1)
- Supports: macOS, Windows, Linux (via Electron and CLI)

**Package Manager:**
- pnpm 10.28.1 (monorepo-style package management)
- Lockfile: `pnpm-lock.yaml` (present)

## Frameworks

**Core:**
- Express 5.2.1 - HTTP server and REST routing
- React 19.2.4 - Frontend UI
- React Router 7.13.0 - Client-side routing (`src/client/router.tsx`)
- tRPC 11.9.0 - Type-safe RPC layer (backend: `src/backend/trpc/`, client: `@trpc/react-query`)
- Prisma 7.3.0 - ORM and database layer

**UI Component Library:**
- shadcn/ui (Radix UI primitives with Tailwind styling)
- Includes: Accordion, Dialog, Select, Tabs, Tooltip, Popover, etc. (30+ components)
- Class Variance Authority 0.7.1 - Component variant patterns
- cmdk 1.1.1 - Command palette / search UI

**Styling & Layout:**
- Tailwind CSS 4.1.18 (@tailwindcss/vite plugin for dev)
- Tailwind typography plugin 0.5.19 - Markdown/rich text styling
- PostCSS 8.5.6 - CSS processing
- Tailwind merge 3.4.0 - Utility class composition
- Tailwindcss animate 1.0.7 - Animation utilities

**Terminal/Editor Integration:**
- XTerm.js 6.0.0 (@xterm/xterm, @xterm/addon-fit) - Terminal emulation UI
- node-pty 1.1.0 - Pseudo-terminal (native module, Electron rebuild required)

**Visualization:**
- Recharts 3.7.0 - Chart library
- Mermaid 11.12.2 - Diagram rendering
- React Markdown 10.1.0 - Markdown rendering (+ rehype-raw, rehype-sanitize, remark-gfm)
- React Syntax Highlighter 16.1.0 - Code block highlighting
- Embla Carousel 8.6.0 - Carousel component

**Drag & Drop:**
- @dnd-kit/core 6.3.1 - Headless drag-drop foundation
- @dnd-kit/sortable 10.0.0 - Sortable list extension
- @dnd-kit/utilities 3.2.2 - Helper utilities

**Forms & Validation:**
- react-hook-form 7.71.1 - Form state management
- @hookform/resolvers 5.2.2 - Validation resolver adapters
- Zod 4.3.6 - Schema validation (TypeScript-first)

**Data Management:**
- @tanstack/react-query 5.90.20 - Server state management (caching, sync)
- @tanstack/react-virtual 3.13.18 - Virtual scrolling for lists
- SuperJSON 2.2.6 - JSON serialization for complex types
- Sonner 2.0.7 - Toast notifications

**Database:**
- better-sqlite3 12.6.2 (native) - SQLite driver with performance optimization
- @prisma/adapter-better-sqlite3 7.3.0 - Prisma adapter for SQLite
- SQLite database location: `~/factory-factory/data.db` (or `DATABASE_PATH`)

**Terminal & CLI:**
- commander 14.0.3 - CLI argument parsing
- node-pty 1.1.0 - Pseudo-terminal spawning (native module)
- tree-kill 1.2.2 - Process tree termination
- pidusage 4.0.1 - Process memory/CPU monitoring
- chalk 5.6.2 - Terminal color output
- open 11.0.0 - Launch URLs/files in default apps

**Utilities:**
- date-fns 4.1.0 - Date manipulation
- p-limit 7.2.0 - Promise concurrency control
- ws 8.19.0 - WebSocket server/client
- input-otp 1.4.2 - OTP input component
- lucide-react 0.563.0 - Icon library
- geist 1.5.1 - Font/UI kit
- dotenv 17.2.3 - Environment variable loading
- vaul 1.1.2 - Drawer/sheet component

**Electron:**
- Electron 40.1.0 - Desktop application framework
- electron-builder 26.7.0 - App packaging and distribution
- @electron/rebuild 4.0.3 - Native module rebuilding

## Testing

**Framework:**
- Vitest 4.0.18 - Test runner (compatible with Jest API)
- @vitest/coverage-v8 4.0.18 - Code coverage (v8 provider)
- jsdom 28.0.0 - DOM implementation for Node
- supertest 7.2.2 - HTTP assertion library

**Test Configuration:**
- Location: `vitest.config.ts`
- Tests: `src/**/*.test.ts`, `src/**/*.test.tsx`
- Setup file: `src/backend/testing/setup.ts`
- Coverage: Backend-only (src/backend/**/*.ts), excludes tests and index.ts
- Commands: `pnpm test`, `pnpm test:watch`, `pnpm test:coverage`

## Build & Dev Tools

**Build:**
- TypeScript Compiler (tsc) - Backend build (`tsconfig.backend.json`)
- tsc-alias - Path alias resolution post-compile
- Vite 7.3.1 (@vitejs/plugin-react) - Frontend build and dev server
- Storybook 10.2.4 - Component documentation/sandbox

**Code Quality:**
- Biome 2.3.13 (@biomejs/biome) - Linting and formatting (replaces ESLint + Prettier)
- Configuration: `biome.json` (2-space indent, 100 char line width, single quotes)
- Dependency Cruiser 17.3.7 - Dependency graph analysis
- Knip 5.83.0 - Unused dependency detection

**Development:**
- tsx 4.21.0 - TypeScript file runner (with HMR via tsx watch)
- concurrently 9.2.1 - Run multiple processes simultaneously
- wait-on 9.0.3 - Wait for server/resource availability
- husky 9.1.7 - Git hooks
- lint-staged 16.2.7 - Run linters on staged files
- next-themes 0.4.6 - Theme provider (light/dark mode)

**Electron Development:**
- electron-builder - Distributable packaging
- tsc for electron TypeScript (`tsconfig.electron.json`)

## Configuration Files

**TypeScript:**
- `tsconfig.json` - Base configuration (ES2022, React JSX, strict mode)
- `tsconfig.backend.json` - Backend build config (extends base)
- `tsconfig.electron.json` - Electron process config
- Path aliases: `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`

**Build & Frontend:**
- `vite.config.ts` - Frontend dev server and build (proxy to `/api`, `/chat`, `/terminal`, `/dev-logs`)
- `vitest.config.ts` - Test runner and coverage settings
- `electron-builder.yml` - Electron app packaging, native module inclusion/unpacking

**Code Quality:**
- `biome.json` - Linting/formatting rules with overrides for generated code, tests, and Storybook

**Git:**
- `.husky/` - Pre-commit hooks (husky config)
- Lint-staged config in `package.json` - Run Biome on staged files

## Platform Requirements

**Development:**
- Node.js (no version specified; pnpm 10.28.1 required)
- Git (for worktrees and version control)
- GitHub CLI (`gh`) - Optional but required for GitHub integration features
- pnpm (pinned to 10.28.1 in package.json)

**Production / Deployment:**
- **CLI/Server:** Standalone Node.js application
  - Runs via `pnpm start` (compiled backend)
  - Outputs BACKEND_PORT for process communication
  - Requires write access to database path

- **Electron:** macOS, Windows, Linux desktop apps
  - Built via `pnpm build:electron`
  - Includes native modules: better-sqlite3, node-pty
  - Uses electron-builder for packaging (DMG/ZIP on macOS, NSIS on Windows, AppImage/DEB on Linux)

- **Database:** SQLite (no external DB required)
  - Default: `~/factory-factory/data.db`
  - Configurable via `DATABASE_PATH` or `BASE_DIR` environment variables

---

*Stack analysis: 2026-02-10*
