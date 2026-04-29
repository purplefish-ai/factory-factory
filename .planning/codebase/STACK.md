# Technology Stack

**Analysis Date:** 2026-04-29

## Languages

**Primary:**
- TypeScript 5.9.3 - Application, backend, CLI, Electron main process, React UI, tests, and shared workspace package. Configured in `tsconfig.json`, `tsconfig.backend.json`, `tsconfig.electron.json`, `packages/core/tsconfig.json`, and scripts in `package.json`.
- SQL - Prisma-generated SQLite migrations in `prisma/migrations/*/migration.sql`.

**Secondary:**
- JavaScript / MJS - Build and validation scripts in `scripts/*.mjs`, including `scripts/postinstall.mjs`, `scripts/ensure-native-modules.mjs`, `scripts/check-no-direct-process-env.mjs`, and `scripts/check-codex-schema-drift.mjs`.
- CSS - Tailwind/CSS variable styling in `src/client/globals.css`; PostCSS config in `postcss.config.mjs`.
- YAML - CI, packaging, and deployment config in `.github/workflows/ci.yml`, `.github/workflows/docker-publish.yml`, `.github/workflows/npm-publish.yml`, `.github/workflows/electron-release.yml`, `docker-compose.yml`, and `electron-builder.yml`.

## Runtime

**Environment:**
- Node.js ESM runtime. `package.json` requires `^20.19 || ^22.12 || >=24.0`.
- Browser runtime for the Vite React SPA mounted from `index.html` and bootstrapped by `src/client/main.tsx`.
- Electron runtime for desktop packaging; Electron main process lives under `electron/` and starts the backend in-process through `electron/main/server-manager.ts`.
- Docker runtime uses `node:20-alpine` by default via `ARG NODE_VERSION=20` in `Dockerfile`.

**Package Manager:**
- pnpm 10.28.1, declared in `package.json`.
- Lockfile: present at `pnpm-lock.yaml` with lockfileVersion `9.0`.
- Workspace packages are declared in `pnpm-workspace.yaml`; `packages/core` is built before root app commands.

## Frameworks

**Core:**
- Express 5.2.1 - Backend HTTP server, static SPA serving, middleware, and health routes in `src/backend/server.ts`, `src/backend/middleware/*.ts`, and `src/backend/routers/health.router.ts`.
- tRPC 11.10.0 - Type-safe API mounted at `/api/trpc` in `src/backend/server.ts`; backend routers live in `src/backend/trpc/*.trpc.ts`; client setup is in `src/client/lib/trpc.ts`.
- React 19.2.4 - Frontend UI under `src/client/` and shared components under `src/components/`.
- React Router 7.13.1 - Browser routing in `src/client/router.tsx`.
- TanStack React Query 5.90.21 - Client query cache/provider in `src/client/lib/providers.tsx`.
- WebSocket (`ws` 8.19.0) - Chat, terminal, setup terminal, dev logs, post-run logs, and snapshots endpoints in `src/backend/server.ts` and `src/backend/routers/websocket/*.ts`.
- Prisma 7.7.0 with SQLite - Data access through generated client `@prisma-gen/client`; schema in `prisma/schema.prisma`; runtime client in `src/backend/db.ts`.
- Electron 40.8.5 - Desktop shell and packaging through `electron/`, `tsconfig.electron.json`, and `electron-builder.yml`.
- Agent Client Protocol - Agent sessions use `@agentclientprotocol/sdk` 0.15.0, `@agentclientprotocol/claude-agent-acp` 0.25.3, and the internal Codex ACP adapter in `src/backend/services/session/service/acp/`.

**Testing:**
- Vitest 4.0.18 - Root test config in `vitest.config.ts`; co-located tests under `src/**/*.test.ts`, `src/**/*.test.tsx`, and `electron/**/*.test.ts`.
- V8 coverage via `@vitest/coverage-v8` 4.0.18 - Coverage config in `vitest.config.ts`; critical backend coverage check in `scripts/check-critical-coverage.mjs`.
- Playwright 1.58.2 - Mobile E2E command `pnpm test:e2e:mobile` in `package.json`; config expected at `playwright.mobile.config.ts`.
- Storybook 10.3.5 - UI story builds via `pnpm build:storybook`; stories are co-located as `*.stories.tsx`.
- Supertest 7.2.2 and jsdom 29.0.2 - Backend route testing and DOM-capable component tests.

**Build/Dev:**
- Vite 7.3.2 - React SPA dev server and production build configured in `vite.config.ts`; output goes to `dist/client`.
- TypeScript compiler - Backend/CLI build uses `tsc -p tsconfig.backend.json`; Electron build uses `tsc -p tsconfig.electron.json`.
- `tsx` 4.21.0 - Development execution for CLI/backend in `package.json` and `src/cli/index.ts`.
- `tsc-alias` 1.8.16 - Backend path alias rewrite during `pnpm build`.
- Biome 2.4.4 - Formatting and linting in `biome.json`; root scripts `pnpm check` and `pnpm check:fix`.
- dependency-cruiser 17.3.8 and Knip 5.85.0 - Dependency architecture and unused-code checks through `pnpm deps:check` and `pnpm knip`.

## Key Dependencies

**Critical:**
- `@trpc/server`, `@trpc/client`, `@trpc/react-query` 11.10.0 - Primary HTTP API contract between `src/backend/trpc/index.ts` and `src/client/lib/trpc.ts`.
- `@prisma/client`, `prisma`, `@prisma/adapter-better-sqlite3` 7.7.0 - SQLite persistence stack; versions are pinned exactly in `package.json` and enforced in `.github/workflows/npm-publish.yml`.
- `better-sqlite3` 12.6.2 - Native SQLite driver used by Prisma adapter in `src/backend/db.ts` and migration runner in `src/backend/migrate.ts`.
- `@agentclientprotocol/sdk` 0.15.0 - ACP client/server contracts in `src/backend/services/session/service/acp/`.
- `@agentclientprotocol/claude-agent-acp` 0.25.3 - Claude session adapter resolved/spawned by `src/backend/services/session/service/acp/acp-runtime-manager.ts`.
- `@linear/sdk` 76.0.0 - Linear API client in `src/backend/services/linear/service/linear-client.service.ts`.
- `ws` 8.19.0 - Backend WebSocket server in `src/backend/server.ts`.
- `node-pty` 1.1.0 - Persistent workspace terminals in `src/backend/services/terminal/service/terminal.service.ts` and setup terminal WebSocket in `src/backend/routers/websocket/setup-terminal.handler.ts`.
- `zod` 4.3.6 - Runtime validation for env config, tRPC inputs, WebSocket messages, GitHub CLI JSON, Linear config, and schema guardrails.

**Infrastructure:**
- `commander` 14.0.3 and `chalk` 5.6.2 - CLI commands and output in `src/cli/index.ts`.
- `dotenv` 17.3.1 - Environment loading in `src/backend/db.ts`, `src/backend/index.ts`, `src/cli/index.ts`, and `prisma.config.ts`.
- `p-limit` 7.3.0 - Concurrency limiting for GitHub CLI calls and ACP runtime startup in `src/backend/services/github/service/github-cli.service.ts` and `src/backend/services/session/service/acp/acp-runtime-manager.ts`.
- `pidusage` 4.0.1 - Terminal resource monitoring in `src/backend/services/terminal/service/terminal.service.ts`.
- `open` 11.0.0 - CLI browser launch in `src/cli/index.ts`.
- `tree-kill` 1.2.2 - Process tree shutdown in `src/cli/index.ts` and runtime utilities.
- `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 - Browser terminal UI under `src/components/workspace/`.
- Radix UI packages, `class-variance-authority`, `tailwind-merge`, `lucide-react`, and `cmdk` - shadcn-style shared UI in `src/components/` and config in `components.json`.
- `react-markdown`, `remark-gfm`, `rehype-raw`, `rehype-sanitize`, `react-syntax-highlighter`, `refractor`, and `mermaid` - Rich message/rendering features in chat and agent activity components under `src/components/`.

## Configuration

**Environment:**
- Central backend env parsing uses `ConfigEnvSchema` and `LoggerEnvSchema` in `src/backend/services/env-schemas.ts`; runtime access goes through `src/backend/services/config.service.ts`.
- `.env.example` file present - contains sample environment configuration and must not be treated as a secrets source.
- Main backend env vars: `BASE_DIR`, `WORKTREE_BASE_DIR`, `REPOS_DIR`, `DATABASE_PATH`, `MIGRATIONS_PATH`, `FRONTEND_STATIC_PATH`, `BACKEND_PORT`, `BACKEND_HOST`, `NODE_ENV`, `SHELL`, `WEB_CONCURRENCY`, and `CORS_ALLOWED_ORIGINS`.
- Agent/runtime env vars: `DEFAULT_MODEL`, `DEFAULT_PERMISSIONS`, `CLAUDE_CONFIG_DIR`, `ACP_STARTUP_TIMEOUT_MS`, `ACP_TRACE_LOGS_ENABLED`, `ACP_TRACE_LOGS_PATH`, `WS_LOGS_ENABLED`, `FF_RUN_SCRIPT_PROXY_ENABLED`, `EVENT_COMPRESSION_ENABLED`, and `BRANCH_RENAME_MESSAGE_THRESHOLD`.
- Logging/notification/rate-limit env vars: `LOG_LEVEL`, `SERVICE_NAME`, `CLAUDE_RATE_LIMIT_PER_MINUTE`, `CLAUDE_RATE_LIMIT_PER_HOUR`, `RATE_LIMIT_QUEUE_SIZE`, `RATE_LIMIT_QUEUE_TIMEOUT_MS`, `NOTIFICATION_SOUND_ENABLED`, `NOTIFICATION_PUSH_ENABLED`, `NOTIFICATION_SOUND_FILE`, `NOTIFICATION_QUIET_HOURS_START`, `NOTIFICATION_QUIET_HOURS_END`, and `HEALTH_CHECK_INTERVAL_MS`.
- Frontend build/dev env vars: `BACKEND_URL`, `VITE_BASE_PATH`, `DEBUG_CHAT_WS`, `VITE_ENABLE_MOBILE_BASELINE`, and Vite-provided `BASE_URL`.
- Electron sets `DATABASE_PATH`, `FRONTEND_STATIC_PATH`, `WS_LOGS_PATH`, and `NODE_ENV` before importing backend modules in `electron/main/server-manager.ts`.

**Build:**
- Root TypeScript config: `tsconfig.json`.
- Backend/CLI TypeScript build: `tsconfig.backend.json`.
- Electron TypeScript build: `tsconfig.electron.json`.
- Frontend build/dev config: `vite.config.ts`.
- Test config: `vitest.config.ts` and `packages/core/vitest.config.ts`.
- Prisma config: `prisma.config.ts`; schema at `prisma/schema.prisma`; migrations at `prisma/migrations/`.
- Lint/format config: `biome.json` with custom Grit rules under `biome-rules/`.
- UI config: `components.json`, `postcss.config.mjs`, `tailwind.config.ts`, and `src/client/globals.css`.
- Packaging/deployment config: `Dockerfile`, `docker-compose.yml`, `electron-builder.yml`, and `.github/workflows/*.yml`.
- Build command flow in `package.json`: build `@factory-factory/core`, check ambiguous imports, compile backend, rewrite aliases, fix Prisma imports, copy `prompts/`, then `vite build`.

## Platform Requirements

**Development:**
- Use Node.js satisfying `^20.19 || ^22.12 || >=24.0` and pnpm 10.28.1 from `package.json`.
- Run `pnpm install --frozen-lockfile`, `pnpm db:generate`, and use `pnpm dev` for CLI-managed backend plus Vite frontend.
- Native modules `better-sqlite3` and `node-pty` must compile for the current runtime; `scripts/ensure-native-modules.mjs` handles Node/Electron rebuild differences.
- Git CLI and GitHub CLI are required for workspace and GitHub features; GitHub auth is checked in `src/backend/services/github/service/github-cli.service.ts`.
- Claude CLI and Codex CLI are provider capabilities checked in `src/backend/orchestration/cli-health.service.ts`; Codex schema drift checks require the Codex CLI in `.github/workflows/ci.yml`.

**Production:**
- npm package exposes `ff` and `factory-factory` binaries from `dist/src/cli/index.js` via `package.json`.
- Production CLI mode serves the compiled backend and Vite SPA from `dist/src/backend/index.js` and `dist/client` in `src/cli/index.ts`.
- Docker production image is built from `Dockerfile`, exposes port `7001`, stores app data under `/data`, and installs GitHub CLI, Cloudflare `cloudflared`, Claude Code CLI, Codex CLI, Python tooling, and native build tooling.
- `docker-compose.yml` runs the `factoryfactory` service with `DATABASE_PATH=/data/data.db`, `BASE_DIR=/data`, `WORKTREE_BASE_DIR=/data/worktrees`, and `BACKEND_PORT=7001`.
- Electron packages include compiled backend, frontend, Prisma migrations/client, native modules, and prompt assets through `electron-builder.yml`; runtime data is stored under Electron `app.getPath('userData')` in `electron/main/server-manager.ts`.

---

*Stack analysis: 2026-04-29*
