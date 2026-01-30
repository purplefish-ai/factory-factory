# Technology Stack

**Analysis Date:** 2026-01-29

## Languages

**Primary:**
- TypeScript 5.9.3 - Full codebase (frontend, backend, Electron)
- JavaScript - Configuration files, build scripts

**Secondary:**
- HTML/CSS - Frontend markup and styling

## Runtime

**Environment:**
- Node.js (ES2022+ target, ESNext modules)

**Package Manager:**
- pnpm 10.28.1
- Lockfile: pnpm-lock.yaml (present)

## Frameworks

**Frontend:**
- React 19.2.4 - UI library
- React Router 7.13.0 - Client-side routing (`src/client/router.tsx`)
- Vite 7.3.1 - Frontend build tool and dev server

**Backend:**
- Express 5.2.1 - HTTP server (`src/backend/index.ts`)
- tRPC 11.9.0 - RPC framework for API (`src/backend/trpc/`)
  - `@trpc/server` - Server implementation
  - `@trpc/client` - Client library
  - `@trpc/react-query` - React integration

**Desktop:**
- Electron 40.1.0 - Desktop app wrapper (`electron/`)
- electron-builder 26.4.0 - Packaging and distribution

**Testing:**
- Vitest 4.0.18 - Unit testing framework
- @vitest/coverage-v8 - Code coverage (v8 provider)

**Build/Dev:**
- tsc-alias 1.8.16 - Path alias resolution
- tsx 4.21.0 - TypeScript executor for Node.js
- concurrently 9.1.0 - Run multiple dev processes
- wait-on 8.0.3 - Wait for services to be ready

**Code Quality:**
- Biome 2.3.13 - Linting and formatting (`biome.json`)
- husky 9.1.7 - Git hooks
- lint-staged 16.2.7 - Staged file linting
- dependency-cruiser 17.3.7 - Dependency graph analysis
- knip 5.82.1 - Unused file/dependency detection

**Documentation:**
- Storybook 10.2.1 - Component documentation
- @storybook/react 10.2.1
- @storybook/react-vite - Vite integration
- @storybook/addon-themes - Theme support
- @storybook/addon-a11y - Accessibility audit

## Key Dependencies

**Critical - Database:**
- @prisma/client 7.3.0 - ORM for database access
- @prisma/adapter-better-sqlite3 7.3.0 - SQLite adapter
- better-sqlite3 12.6.2 - Native SQLite driver
- prisma 7.3.0 - CLI and migration tools

**Critical - Real-time Communication:**
- ws 8.19.0 - WebSocket server for `/chat` and `/terminal` endpoints
- @xterm/xterm 6.0.0 - Terminal emulator
- @xterm/addon-fit 0.11.0 - Xterm fit plugin
- node-pty 1.1.0 - PTY (pseudo-terminal) spawning for terminal sessions

**Critical - Claude Integration:**
- Spawns Claude CLI as child process via `src/backend/claude/process.ts`
- Uses JSON protocol for streaming messages
- Managed by `ClaudeClient` and `SessionManager` (`src/backend/claude/index.ts`)

**API/Data Formats:**
- superjson 2.2.6 - Enhanced JSON serialization (for tRPC)
- zod 4.3.6 - Runtime schema validation

**UI Components:**
- @radix-ui/* (29 packages) - Headless UI components
  - Includes: accordion, alert-dialog, avatar, checkbox, dialog, dropdown-menu, popover, select, tabs, etc.
- lucide-react 0.563.0 - Icon library
- react-markdown 10.1.0 - Markdown rendering
- react-syntax-highlighter 16.1.0 - Code highlighting

**UI State Management:**
- @tanstack/react-query 5.90.20 - Server state management
- react-hook-form 7.71.1 - Form state management
- @hookform/resolvers 5.2.2 - Form validation resolvers

**Styling:**
- Tailwind CSS 4.1.18 - Utility CSS framework
- @tailwindcss/postcss 4.1.18 - PostCSS plugin
- @tailwindcss/vite 4.1.18 - Vite integration
- tailwind-merge 3.4.0 - Merge Tailwind classes
- tailwindcss-animate 1.0.7 - Animation utilities
- tw-animate-css 1.4.0 - CSS animation helpers
- PostCSS 8.5.6 - CSS processing
- autoprefixer 10.4.23 - Vendor prefixes

**UI Layout/Motion:**
- react-resizable-panels 4.5.3 - Resizable panels
- embla-carousel-react 8.6.0 - Carousel component
- vaul 1.1.2 - Drawer/sheet component
- recharts 3.7.0 - Charts/graphs library
- react-day-picker 9.13.0 - Date picker
- cmdk 1.1.1 - Command palette
- sonner 2.0.7 - Toast notifications
- class-variance-authority 0.7.1 - Variant CSS utility
- clsx 2.1.1 - Classname utilities

**Utilities:**
- date-fns 4.1.0 - Date manipulation
- dotenv 17.2.3 - Environment variable loading
- chalk 5.6.2 - Terminal color output
- open 11.0.0 - Open URLs/apps
- p-limit 7.2.0 - Promise concurrency control
- pidusage 4.0.1 - Process CPU/memory monitoring
- commander 14.0.2 - CLI framework
- input-otp 1.4.2 - OTP input component
- geist 1.5.1 - Font package
- @types/* - TypeScript type definitions

**Development Utilities:**
- @electron/rebuild 4.0.2 - Rebuild native modules for Electron
- next-themes 0.4.6 - Theme management
- @vitejs/plugin-react 5.1.2 - React plugin for Vite

## Configuration

**Environment:**
Environment variables managed via `.env` (see `.env.example`):
- `DATABASE_PATH` - SQLite database file location (defaults to `~/factory-factory/data.db`)
- `BACKEND_PORT` - Express server port (default: 3001 for dev, 4001 in production)
- `FRONTEND_PORT` - Vite dev server port (default: 4000)
- `NODE_ENV` - Environment (development/production/test)
- `BASE_DIR` - Base directory for worktrees and logs
- `WORKTREE_BASE_DIR` - Git worktree base path
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins
- `LOG_LEVEL` - Logging level (error, warn, info, debug)
- `ORCHESTRATOR_MODEL`, `SUPERVISOR_MODEL`, `WORKER_MODEL` - Claude model selection (sonnet, opus, haiku)
- `ORCHESTRATOR_PERMISSIONS`, `SUPERVISOR_PERMISSIONS`, `WORKER_PERMISSIONS` - Permission modes (strict, relaxed, yolo)

**TypeScript:**
- `tsconfig.json` - Main configuration with ES2022 target, strict mode enabled
- `tsconfig.backend.json` - Backend-specific configuration
- `tsconfig.electron.json` - Electron-specific configuration
- Path aliases: `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`

**Build:**
- `vite.config.ts` - Frontend build config with React plugin and Tailwind
  - Proxy setup for `/api`, `/chat`, `/terminal` WebSocket endpoints
- `vitest.config.ts` - Test configuration (node environment, v8 coverage)
- `postcss.config.mjs` - PostCSS with Tailwind plugin
- `tailwind.config.ts` - Tailwind CSS configuration
- `biome.json` - Linter/formatter with strict rules
- `.npmrc` - npm registry config for monorepo dependencies

**Database:**
- `prisma/schema.prisma` - Data schema with SQLite datasource
- Migrations: `prisma/migrations/` directory

## Platform Requirements

**Development:**
- Node.js (version not explicitly pinned, assumes LTS)
- macOS, Linux, or Windows with native module support (better-sqlite3, node-pty require compilation)

**Production:**
- Node.js runtime for backend
- SQLite (bundled with better-sqlite3)
- Electron distributable packages for desktop (`.dmg` on macOS, `.exe` on Windows, `.deb`/`.AppImage` on Linux)

**Desktop Packaging:**
- electron-builder configuration in `electron-builder.yml`
- Distributable formats:
  - macOS: DMG, ZIP
  - Windows: NSIS installer
  - Linux: AppImage, DEB package

---

*Stack analysis: 2026-01-29*
