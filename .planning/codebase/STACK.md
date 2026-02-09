# Technology Stack

**Analysis Date:** 2026-02-09

## Languages

**Primary:**
- TypeScript 5.9.3 - Backend, frontend, CLI, and Electron main process
- TSX (TypeScript + React) - React components and client code

**Secondary:**
- JavaScript (Node.js) - Build scripts, postinstall hooks

## Runtime

**Environment:**
- Node.js (latest LTS recommended, referenced in build scripts)
- Electron 40.1.0 - Desktop application wrapper

**Package Manager:**
- pnpm 10.28.1 (enforced via `packageManager` field in package.json)
- Lockfile: `pnpm-lock.yaml` (present)

## Frameworks

**Core:**
- Express 5.2.1 - Backend HTTP server with middleware
- React 19.2.4 - UI framework for web and Electron
- Vite 7.3.1 - Frontend build tool and dev server
- tRPC 11.9.0 - RPC framework for backend/frontend communication

**Testing:**
- Vitest 4.0.18 - Unit and integration test runner
- Supertest 7.2.2 - HTTP assertion library for API testing

**Build/Dev:**
- TypeScript 5.9.3 - Compilation and type checking
- tsc-alias 1.8.16 - Path alias resolution in compiled output
- Electron 40.1.0 - Desktop app framework
- electron-builder 26.7.0 - App packaging and distribution
- electron-rebuild 4.0.3 - Native module compilation for Electron
- Storybook 10.2.4 - Component development and documentation

**Code Quality:**
- Biome 2.3.13 - Linting, formatting, and code organization (enforced)
- lint-staged 16.2.7 - Pre-commit hooks for staged files
- husky 9.1.7 - Git hooks management
- dependency-cruiser 17.3.7 - Dependency graph validation
- knip 5.83.0 - Unused dependency detection

## Key Dependencies

**UI Components & Styling:**
- @radix-ui/* - Accessible component primitives (accordion, dialog, dropdown, etc.)
- Tailwind CSS 4.1.18 with @tailwindcss/vite 4.1.18 - Utility-first CSS framework
- tailwind-merge 3.4.0 - Merge Tailwind class conflicts
- tailwindcss-animate 1.0.7 - Animation utilities
- lucide-react 0.563.0 - Icon library
- shadcn/ui components - Pre-built accessible components (via components.json)

**Forms & Validation:**
- zod 4.3.6 - Schema validation and type inference (TypeScript-first)
- react-hook-form 7.71.1 - Performant form state management
- @hookform/resolvers 5.2.2 - Zod integration with react-hook-form

**Data & State Management:**
- @tanstack/react-query 5.90.20 - Server state management and caching
- @trpc/client 11.9.0 - tRPC client library
- @trpc/react-query 11.9.0 - tRPC + React Query integration
- superjson 2.2.6 - JSON serialization supporting dates, bigints, etc.

**Terminal & PTY:**
- node-pty 1.1.0 - Native pseudo-terminal implementation (requires native rebuild)
- @xterm/xterm 6.0.0 - Terminal emulator component
- @xterm/addon-fit 0.11.0 - Terminal fit plugin

**Database:**
- Prisma 7.3.0 - ORM and schema management
- @prisma/client 7.3.0 - Database client
- @prisma/adapter-better-sqlite3 7.3.0 - SQLite database adapter
- better-sqlite3 12.6.2 - High-performance synchronous SQLite driver (native module)

**Markdown & Content:**
- react-markdown 10.1.0 - Markdown rendering component
- remark-gfm 4.0.1 - GitHub Flavored Markdown plugin
- rehype-sanitize 6.0.0 - HTML sanitization
- rehype-raw 7.0.0 - Raw HTML support in markdown
- mermaid 11.12.2 - Diagram rendering (Mermaid syntax)

**UI Features:**
- react-router 7.13.0 - Client-side routing
- react-day-picker 9.13.0 - Date picker component
- recharts 3.7.0 - Charting library
- react-resizable-panels 4.5.9 - Resizable panel layout
- embla-carousel-react 8.6.0 - Carousel component
- vaul 1.1.2 - Drawer component
- sonner 2.0.7 - Toast notification library
- cmdk 1.1.1 - Command palette component
- input-otp 1.4.2 - OTP input component

**Drag & Drop:**
- @dnd-kit/core 6.3.1 - Headless drag-and-drop library
- @dnd-kit/sortable 10.0.0 - Sortable preset for dnd-kit
- @dnd-kit/utilities 3.2.2 - Utility functions for dnd-kit

**Utilities:**
- date-fns 4.1.0 - Date manipulation library
- clsx 2.1.1 - Conditional class name utility
- class-variance-authority 0.7.1 - Component variant patterns
- pidusage 4.0.1 - Process resource usage monitoring
- p-limit 7.2.0 - Concurrency limiter
- dotenv 17.2.3 - Environment variable loading
- chalk 5.6.2 - Terminal color output
- open 11.0.0 - Cross-platform app opener
- commander 14.0.3 - CLI argument parsing and commands
- geist 1.5.1 - Font family
- react-syntax-highlighter 16.1.0 - Code syntax highlighting

**Shared Utilities:**
- ws 8.19.0 - WebSocket server and client
- next-themes 0.4.6 - Theme management (though not Next.js based)

## Configuration

**Environment:**
- Configuration via environment variables (see `.env.example`)
- Critical env vars: `DATABASE_PATH`, `BACKEND_PORT`, `NODE_ENV`, `DEFAULT_MODEL`, `DEFAULT_PERMISSIONS`
- Rate limiting: `CLAUDE_RATE_LIMIT_PER_MINUTE`, `CLAUDE_RATE_LIMIT_PER_HOUR`
- Feature flags: `FEATURE_AUTHENTICATION`, `FEATURE_METRICS`, `FEATURE_ERROR_TRACKING`
- Logging: `LOG_LEVEL`, `SERVICE_NAME`, `WS_LOGS_ENABLED`

**Build:**
- `tsconfig.json` - Shared TypeScript config (strict mode enabled)
- `tsconfig.backend.json` - Backend-specific compilation config
- `tsconfig.electron.json` - Electron main process config
- `vite.config.ts` - Frontend build and dev server config with WebSocket proxies
- `vitest.config.ts` - Test runner configuration with v8 coverage
- `biome.json` - Linting and formatting rules (Biome replaces ESLint/Prettier)

**Development:**
- `.env.example` - Template for environment configuration
- `scripts/ensure-native-modules.mjs` - Ensures native modules are built for target (node/electron)
- `pnpm` overrides for security fixes (tar, lodash, tough-cookie, etc.)

## Platform Requirements

**Development:**
- Node.js with pnpm 10.28.1
- Git for repository management and worktrees
- Python (optional, for some native module builds)
- C++ compiler (for better-sqlite3 and node-pty native modules)
- Electron build tools for desktop app development

**Production:**
- Electron framework for desktop deployment
- SQLite database file system access
- Terminal/PTY support (depends on OS - macOS, Linux, Windows)
- git CLI available in PATH for workspace initialization and PR operations
- GitHub CLI (gh) available in PATH for GitHub integration (optional)

---

*Stack analysis: 2026-02-09*
