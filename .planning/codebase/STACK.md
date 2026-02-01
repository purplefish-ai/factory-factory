# Technology Stack

**Analysis Date:** 2026-02-01

## Languages

**Primary:**
- TypeScript 5.9.3 - Full codebase (backend, frontend, Electron, CLI)
- JavaScript (ESM) - Build scripts, configuration files
- JSX/TSX - React components

**Secondary:**
- CSS/Tailwind CSS - Styling via `@tailwindcss/vite` 4.1.18
- HTML - Static templates and Electron renderer

## Runtime

**Environment:**
- Node.js (ES2022 target, ESNext module output)
- Electron 40.1.0 - Desktop application runtime (macOS, Windows, Linux)

**Package Manager:**
- pnpm 10.28.1 (specified in `packageManager` field)
- Lockfile: `pnpm-lock.yaml` (standard pnpm format)

## Frameworks

**Core Backend:**
- Express 5.2.1 - HTTP server
- tRPC 11.9.0 - Type-safe RPC framework (server + client + React integration)

**Frontend:**
- React 19.2.4 - UI library
- React Router 7.13.0 - Client-side routing (explicit configuration in `src/client/router.tsx`)
- Vite 7.3.1 - Frontend build tool and dev server

**UI Components & Styling:**
- Radix UI (28 packages) - Accessible component primitives
- Tailwind CSS 4.1.18 - Utility-first CSS framework
- Class Variance Authority 0.7.1 - Component variant system
- Geist 1.5.1 - Design system components
- Lucide React 0.563.0 - Icon library

**Desktop:**
- Electron 40.1.0 - Cross-platform desktop framework
- Electron Builder 26.7.0 - Electron application packaging

**Database & ORM:**
- Prisma 7.3.0 - Type-safe ORM
- SQLite (via `@prisma/adapter-better-sqlite3` 7.3.0) - Local database
- Better SQLite3 12.6.2 - High-performance SQLite driver

**Form Handling:**
- React Hook Form 7.71.1 - Form state management
- @hookform/resolvers 5.2.2 - Schema validation adapters
- Zod 4.3.6 - TypeScript-first schema validation

**Data Management:**
- TanStack React Query 5.90.20 - Server state management
- TanStack React Virtual 3.13.18 - Virtual scrolling
- SuperJSON 2.2.6 - JSON serialization for complex types

**Real-time Communication:**
- WebSocket (ws 8.19.0) - WebSocket client/server
- Custom streaming JSON protocol - Claude CLI integration

**Terminal & PTY:**
- node-pty 1.1.0 - Pseudo-terminal support for terminal sessions
- xterm.js 6.0.0 - Terminal emulator UI component
- xterm addon-fit 0.11.0 - Terminal auto-fit plugin

**Utilities:**
- date-fns 4.1.0 - Date manipulation
- commander 14.0.3 - CLI argument parsing
- chalk 5.6.2 - Terminal color output
- dotenv 17.2.3 - Environment variable loading
- open 11.0.0 - Cross-platform open command
- p-limit 7.2.0 - Promise concurrency control
- pidusage 4.0.1 - Process resource monitoring
- sonner 2.0.7 - Toast notifications
- recharts 3.7.0 - Charts library
- react-markdown 10.1.0 - Markdown rendering
- react-syntax-highlighter 16.1.0 - Code highlighting
- mermaid 11.12.2 - Diagram rendering
- embla-carousel-react 8.6.0 - Carousel component
- react-resizable-panels 4.5.7 - Resizable layout panels
- vaul 1.1.2 - Drawer component
- input-otp 1.4.2 - OTP input component
- react-day-picker 9.13.0 - Date picker
- cmdk 1.1.1 - Command menu component
- clsx 2.1.1 - Conditional className utility
- tailwind-merge 3.4.0 - Merge Tailwind classes
- tailwindcss-animate 1.0.7 - Animation plugin

**Testing:**
- Vitest 4.0.18 - Unit test runner
- @vitest/coverage-v8 4.0.18 - Coverage provider
- Supertest 7.2.2 - HTTP assertion library

**Code Quality & Build:**
- Biome 2.3.13 - Linter and formatter (TypeScript, JavaScript, JSON, CSS)
- TypeScript 5.9.3 - Type checking
- tsc-alias 1.8.16 - Path alias resolution for compiled code
- Storybook 10.2.3 - Component documentation
- Dependency Cruiser 17.3.7 - Module dependency analysis
- Knip 5.82.1 - Unused file/dependency detection
- Husky 9.1.7 - Git hooks
- lint-staged 16.2.7 - Pre-commit linting

**Development:**
- tsx 4.21.0 - TypeScript execution (dev scripts)
- concurrently 9.1.0 - Parallel process runner
- wait-on 9.0.3 - Wait for port availability
- @electron/rebuild 4.0.2 - Rebuild native modules for Electron

## Configuration

**Environment:**
- Loaded via dotenv from `.env` file
- Variable expansion supported (e.g., `$USER`, `${BASE_DIR}`)
- Critical variables (defaults shown in `.env.example`):
  - `DATABASE_PATH` - SQLite file location (default: `~/factory-factory/data.db`)
  - `BACKEND_PORT` - Backend server port (default: 4001)
  - `FRONTEND_PORT` - Frontend dev server port (default: 4000)
  - `BASE_DIR` - Worktrees and data base directory (default: `~/factory-factory`)
  - `NODE_ENV` - Environment mode (development/production)
  - `ORCHESTRATOR_MODEL`, `SUPERVISOR_MODEL`, `WORKER_MODEL` - Claude model selection
  - `LOG_LEVEL` - Logging verbosity (error/warn/info/debug)

**Build:**
- TypeScript configuration: `tsconfig.json` (ES2022 target, ESNext modules)
- Backend-specific: `tsconfig.backend.json` (with emission enabled)
- Electron-specific: `tsconfig.electron.json` (Electron main process)
- Vite configuration: `vite.config.ts` (React + Tailwind plugins, path aliases)
- Vitest configuration: `vitest.config.ts` (Node environment, coverage v8)
- Biome configuration: `biome.json` (strict linting, formatting, code assists)
- Prisma: `prisma.config.ts` with schema at `prisma/schema.prisma`
- Tailwind: `tailwind.config.ts` with PostCSS

**Path Aliases:**
- `@/*` → `src/` (shared across codebase)
- `@prisma-gen/*` → `prisma/generated/` (Prisma client)

## Platform Requirements

**Development:**
- Node.js (tested with 20+, type definitions for 25.1.0)
- pnpm 10.28.1+
- Better SQLite3 native module (auto-rebuilt on install)
- node-pty native module (auto-rebuilt on install)
- Git (for git operations)
- gh CLI (GitHub command-line tool) - for GitHub integration
- Claude CLI - for running Claude Code sessions

**Production:**
- Deployment target: macOS (dmg, zip), Windows (NSIS), Linux (AppImage, deb)
- Electron app packaging via electron-builder
- SQLite database at OS-specific path (or `DATABASE_PATH`)
- Prisma migrations applied at startup

**Native Modules:**
- `better-sqlite3` 12.6.2 - SQLite database driver
- `node-pty` 1.1.0 - PTY/terminal spawning
- Both unpacked in Electron ASAR archive for Node.js module loading

---

*Stack analysis: 2026-02-01*
