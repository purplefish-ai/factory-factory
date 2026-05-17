# Technology Stack

**Analysis Date:** 2026-05-17

## Languages

**Primary:**
- TypeScript 5.9 (`typescript` `^5.9.3`) - backend, CLI, Electron wrapper, React client, shared types, service capsules, and tests in `src/`, `electron/`, and `packages/core/`
- TSX/React JSX - UI routes and shared components in `src/client/` and `src/components/`

**Secondary:**
- CSS - global Tailwind/CSS styling in `src/client/globals.css`
- Prisma schema / SQL migrations - data model in `prisma/schema.prisma`, migrations in `prisma/migrations/`
- JavaScript / ESM scripts - build and validation scripts in `scripts/*.mjs`
- YAML - GitHub Actions and Electron packaging in `.github/workflows/*.yml` and `electron-builder.yml`
- Shell/Dockerfile syntax - container runtime in `Dockerfile`, local container orchestration in `docker-compose.yml`

## Runtime

**Environment:**
- Node.js ESM runtime with supported engines `^20.19 || ^22.12 || >=24.0` from `package.json`
- Docker production image defaults to Node `20` and pnpm `10.28.1` through `Dockerfile`
- Electron desktop runtime uses `electron` `^40.8.5` with backend modules loaded in the Electron main process from `electron/main/server-manager.ts`

**Package Manager:**
- pnpm `10.28.1` from `package.json`
- Lockfile: present at `pnpm-lock.yaml`
- Workspace layout: `pnpm-workspace.yaml` includes `packages/*`, currently including `packages/core/package.json`

## Frameworks

**Core:**
- Express `^5.2.1` - HTTP server, static SPA serving, health routes, and tRPC adapter in `src/backend/server.ts`
- tRPC `^11.10.0` - backend API routers in `src/backend/trpc/` and typed React client in `src/client/lib/trpc.ts`
- React `^19.2.4` / React DOM `^19.2.4` - frontend application in `src/client/main.tsx`, `src/client/root.tsx`, and `src/client/router.tsx`
- React Router `^7.13.1` - browser routes declared in `src/client/router.tsx`
- Vite `^7.3.2` with `@vitejs/plugin-react` `^5.1.4` - client build/dev server in `vite.config.ts`
- Tailwind CSS `^4.2.1` with `@tailwindcss/vite` `^4.2.1` - frontend styling pipeline in `vite.config.ts` and `src/client/globals.css`
- Prisma `7.7.0` with SQLite - schema in `prisma/schema.prisma`, runtime client in `src/backend/db.ts`, CLI config in `prisma.config.ts`
- Electron `^40.8.5` and `electron-builder` `^26.8.1` - desktop packaging and app lifecycle in `electron/` and `electron-builder.yml`

**Testing:**
- Vitest `^4.0.18` - primary test runner configured in `vitest.config.ts`
- V8 coverage via `@vitest/coverage-v8` `^4.0.18` - backend coverage configured in `vitest.config.ts`
- Playwright `^1.58.2` - mobile/e2e command surface in `package.json`
- Storybook `10.3.6` with `@storybook/react-vite` `10.3.6` - component story builds via `pnpm build:storybook`
- Supertest `^7.2.2` - HTTP test helper dependency in `package.json`

**Build/Dev:**
- `tsx` `^4.21.0` - TypeScript runtime/watch mode for CLI and backend dev commands in `package.json`
- TypeScript compiler (`tsc`) - backend emit through `tsconfig.backend.json`, Electron emit through `tsconfig.electron.json`
- `tsc-alias` `^1.8.16` - post-build alias resolution in `package.json`
- Biome `^2.4.4` - formatter/linter configured in `biome.json`
- Dependency Cruiser `^17.3.8` - dependency architecture checks via `.dependency-cruiser.cjs` and `pnpm deps:check`
- Knip `^5.85.0` - unused file/dependency checks via `pnpm knip`
- Docker Buildx/GHCR - image build/publish workflow in `.github/workflows/docker-publish.yml`

## Key Dependencies

**Critical:**
- `@prisma/client` `7.7.0`, `prisma` `7.7.0`, `@prisma/adapter-better-sqlite3` `7.7.0` - generated Prisma client and SQLite adapter used by `src/backend/db.ts`
- `better-sqlite3` `^12.6.2` - native SQLite driver required by Prisma's better-sqlite3 adapter
- `@agentclientprotocol/sdk` `0.15.0` - ACP JSON-RPC/session protocol used by `src/backend/services/session/service/acp/`
- `@agentclientprotocol/claude-agent-acp` `^0.25.3` - Claude ACP adapter binary resolved in `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- `@linear/sdk` `^76.0.0` - Linear API client in `src/backend/services/linear/service/linear-client.service.ts`
- `ws` `^8.19.0` - WebSocket server in `src/backend/server.ts` and handlers under `src/backend/routers/websocket/`
- `node-pty` `^1.1.0` - interactive terminal service in `src/backend/services/terminal/service/terminal.service.ts`
- `zod` `^4.3.6` - runtime validation for env, API inputs, WebSocket messages, and shared schemas such as `src/backend/services/env-schemas.ts`
- `superjson` `^2.2.6` - tRPC transformer in `src/client/lib/trpc.ts`

**Infrastructure:**
- `commander` `^14.0.3` - CLI command definitions in `src/cli/index.ts`
- `dotenv` `^17.3.1` - environment loading in `src/backend/db.ts`, `src/backend/index.ts`, `src/cli/index.ts`, and `prisma.config.ts`
- `p-limit` `^7.3.0` - concurrency control in GitHub CLI and ACP runtime services
- `pidusage` `^4.0.1` - terminal process resource reporting in `src/backend/services/terminal/service/terminal.service.ts`
- `tree-kill` `^1.2.2` - process-tree cleanup in `src/cli/runtime-utils.ts` and run-script service code
- `qrcode` `^1.5.4` - proxy QR display in `src/cli/proxy.ts`
- `open` `^11.0.0` - browser launch in `src/cli/index.ts`
- `lucide-react` `^0.575.0`, Radix UI packages, `class-variance-authority`, `clsx`, and `tailwind-merge` - shared UI component system in `src/components/ui/`
- `next` `16.2.6` - dependency and TypeScript plugin are present in `package.json` and `tsconfig.json`, but the active client build is Vite/React; Electron packaging excludes Next-related pnpm entries in `electron-builder.yml`

## Configuration

**Environment:**
- Runtime environment variables are validated through Zod schemas in `src/backend/services/env-schemas.ts`
- Centralized runtime config is loaded in `src/backend/services/config.service.ts`; backend files should use `configService` rather than direct `process.env` access
- Database path resolution uses `DATABASE_PATH`, then `BASE_DIR`, then `~/factory-factory/data.db` through `src/backend/lib/env.ts` and `src/cli/database-path.ts`
- Key environment names include `DATABASE_PATH`, `BASE_DIR`, `WORKTREE_BASE_DIR`, `REPOS_DIR`, `BACKEND_PORT`, `BACKEND_HOST`, `FRONTEND_STATIC_PATH`, `MIGRATIONS_PATH`, `LOG_LEVEL`, `SERVICE_NAME`, `CORS_ALLOWED_ORIGINS`, `CLAUDE_CONFIG_DIR`, `ACP_STARTUP_TIMEOUT_MS`, `ACP_TRACE_LOGS_ENABLED`, `ACP_TRACE_LOGS_PATH`, `WS_LOGS_ENABLED`, `WS_LOGS_PATH`, `FF_RUN_SCRIPT_PROXY_ENABLED`, `DEFAULT_MODEL`, `DEFAULT_PERMISSIONS`, `MAX_SESSIONS_PER_WORKSPACE`, and `DEBUG_CHAT_WS`
- `.env.example` is present; env file contents are not read by mapper convention

**Build:**
- `package.json`: scripts, dependency versions, Node engines, pnpm version, CLI binaries
- `tsconfig.json`: strict TypeScript settings and aliases `@/*`, `@prisma-gen/*`, and `@factory-factory/core-types/*`
- `tsconfig.backend.json`: backend/CLI emit into `dist/`
- `tsconfig.electron.json`: Electron process build settings
- `vite.config.ts`: React/Tailwind plugins, dev proxy to backend, WebSocket proxy paths, `VITE_` env prefix, aliases, client output `dist/client`
- `vitest.config.ts`: test include/exclude patterns, V8 coverage, backend setup file, aliases
- `biome.json`: formatting, lint rules, custom Grit plugin rules, generated Prisma exclusions
- `prisma.config.ts`: Prisma schema path, migrations path, and SQLite URL derived from `src/backend/lib/env.ts`
- `Dockerfile`: multi-stage build, native module dependencies, global Claude/Codex CLI install, production env defaults
- `docker-compose.yml`: single-service production deployment, data volume, port binding, and Cloudflare mode env name
- `electron-builder.yml`: Electron app metadata, bundled files/resources, native module unpacking, macOS/Windows/Linux targets
- `.github/workflows/ci.yml`: CI checks, build, Storybook, tests, coverage report
- `.github/workflows/docker-publish.yml`: GHCR Docker image build/push
- `.github/workflows/npm-publish.yml`: npm publishing workflow
- `.github/workflows/electron-release.yml`: Electron artifact build/release workflow

## Platform Requirements

**Development:**
- Install with pnpm and run app through `pnpm dev`, `pnpm dev:backend`, `pnpm dev:frontend`, or `pnpm dev:electron`
- Run validation with `pnpm test`, `pnpm typecheck`, `pnpm check`, `pnpm check:fix`, and `pnpm deps:check`
- Generate Prisma client with `pnpm db:generate`; run migrations with `pnpm db:migrate` or CLI `ff db:migrate`
- Git must be available for project/worktree operations in `src/backend/services/git-ops.service.ts` and `src/backend/clients/git.client.ts`
- GitHub CLI `gh` must be installed and authenticated for GitHub issue/PR workflows in `src/backend/services/github/service/github-cli.service.ts`
- Claude CLI and Codex CLI must be installed/authenticated for agent runtimes; health checks live in `src/backend/orchestration/cli-health.service.ts`
- Native modules `better-sqlite3` and `node-pty` are rebuilt for Node/Electron by `scripts/ensure-native-modules.mjs`

**Production:**
- Production CLI/server mode serves Express API and the built Vite SPA from one backend port via `src/backend/server.ts`
- Docker production defaults to `BACKEND_PORT=7001`, `DATABASE_PATH=/data/data.db`, `BASE_DIR=/data`, and `WORKTREE_BASE_DIR=/data/worktrees` in `Dockerfile`
- Electron production stores SQLite data in Electron `userData`, runs migrations from packaged resources, and serves unpacked frontend assets through the in-process backend in `electron/main/server-manager.ts`
- npm package exposes `ff` and `factory-factory` binaries from `dist/src/cli/index.js`
- Service capsules must expose public APIs through `src/backend/services/{name}/index.ts`; cross-service consumers should import barrels and respect `src/backend/services/registry.ts`

---

*Stack analysis: 2026-05-17*
