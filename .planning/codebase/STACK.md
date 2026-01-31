# Technology Stack

**Analysis Date:** 2026-01-31

## Languages

**Primary:**
- TypeScript 5.9.3 - All application code (frontend, backend, CLI, Electron)

**Secondary:**
- SQL - Prisma schema and migrations (`prisma/schema.prisma`, `prisma/migrations/`)

## Runtime

**Environment:**
- Node.js - ES2022 target with ESM modules
- Electron 40.1.0 - Desktop app wrapper

**Package Manager:**
- pnpm 10.28.1 (enforced via `packageManager` field)
- Lockfile: `pnpm-lock.yaml` present

## Frameworks

**Core:**
- React 19.2.4 - Frontend UI framework
- React Router 7.13.0 - Client-side routing (`src/client/router.tsx`)
- Express 5.2.1 - Backend HTTP server (`src/backend/server.ts`)
- tRPC 11.9.0 - Type-safe API layer (`src/backend/trpc/`)

**Testing:**
- Vitest 4.0.18 - Test runner (`vitest.config.ts`)
- Supertest 7.2.2 - HTTP assertion testing

**Build/Dev:**
- Vite 7.3.1 - Frontend build and dev server (`vite.config.ts`)
- tsx 4.21.0 - TypeScript execution for backend/CLI
- tsc-alias 1.8.16 - Path alias resolution post-compile

## Key Dependencies

**Critical:**
- `@prisma/client` 7.3.0 - Database ORM with SQLite adapter
- `better-sqlite3` 12.6.2 - Native SQLite driver
- `node-pty` 1.1.0 - PTY terminal sessions for workspace terminals
- `ws` 8.19.0 - WebSocket server for real-time chat/terminal
- `commander` 14.0.2 - CLI framework (`src/cli/index.ts`)

**UI Component Library:**
- Radix UI primitives (20+ components) - Accessible UI building blocks
- `cmdk` 1.1.1 - Command palette
- `@xterm/xterm` 6.0.0 - Terminal emulator for workspace terminals
- `lucide-react` 0.563.0 - Icon library

**State & Data:**
- `@tanstack/react-query` 5.90.20 - Server state management with tRPC integration
- `@tanstack/react-virtual` 3.13.18 - Virtualized lists
- `zod` 4.3.6 - Schema validation

**Styling:**
- Tailwind CSS 4.1.18 - Utility-first CSS (`tailwind.config.ts`)
- `tailwindcss-animate` 1.0.7 - Animation utilities
- `class-variance-authority` 0.7.1 - Variant management
- `geist` 1.5.1 - Font family

**Infrastructure:**
- `superjson` 2.2.6 - Serialization for tRPC
- `pidusage` 4.0.1 - Process resource monitoring
- `dotenv` 17.2.3 - Environment variable loading

## Configuration

**Environment:**
- `.env` / `.env.example` - Environment configuration
- Key vars: `DATABASE_PATH`, `BACKEND_PORT`, `FRONTEND_PORT`, `BASE_DIR`
- Agent config: `ORCHESTRATOR_MODEL`, `SUPERVISOR_MODEL`, `WORKER_MODEL`
- Feature flags: `FEATURE_AUTHENTICATION`, `FEATURE_METRICS`, `FEATURE_ERROR_TRACKING`

**Build:**
- `tsconfig.json` - Base TypeScript config (strict mode, ES2022)
- `tsconfig.backend.json` - Backend-specific config
- `tsconfig.electron.json` - Electron-specific config
- `vite.config.ts` - Frontend bundling with path aliases
- `vitest.config.ts` - Test configuration
- `biome.json` - Linting and formatting (replaces ESLint/Prettier)
- `prisma.config.ts` - Database configuration

## Build & Development Tools

**Linting/Formatting:**
- Biome 2.3.13 - Fast linter and formatter (`biome.json`)
- Custom rules: no-await-import, no-native-dialogs (Grit plugins)

**Git Hooks:**
- Husky 9.1.7 - Git hooks manager
- lint-staged 16.2.7 - Pre-commit file processing

**Code Quality:**
- dependency-cruiser 17.3.7 - Dependency analysis (`deps:check`)
- knip 5.82.1 - Unused code detection

**Electron Build:**
- electron-builder 26.4.0 - Package distribution
- @electron/rebuild 4.0.2 - Native module rebuilding

**Documentation:**
- Storybook 10.2.1 - Component development (`@storybook/react-vite`)

## Runtime Requirements

**Development:**
- Node.js (ES2022 compatible, likely 18+)
- pnpm 10.28.1 (exact version)
- SQLite (native, via better-sqlite3)
- `claude` CLI installed (for AI features)
- `gh` CLI installed (for GitHub integration)

**Production:**
- Same Node.js requirements
- Electron for desktop distribution
- Native modules: `better-sqlite3`, `node-pty` (platform-specific prebuilds)

## Platform Support

**Desktop (Electron):**
- macOS: `~/Library/Application Support/Factory Factory/data.db`
- Windows: `%APPDATA%/Factory Factory/data.db`
- Linux: `~/.config/Factory Factory/data.db`

**Web/CLI:**
- Default: `~/factory-factory/data.db`
- Configurable via `DATABASE_PATH` or `BASE_DIR` env vars

---

*Stack analysis: 2026-01-31*
