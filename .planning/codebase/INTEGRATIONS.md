# External Integrations

**Analysis Date:** 2026-04-29

## APIs & External Services

**GitHub:**
- GitHub Issues, Pull Requests, reviews, diffs, status checks, and issue comments are accessed through the locally authenticated GitHub CLI, not a direct REST SDK.
  - SDK/Client: `gh` CLI spawned with `execFile` in `src/backend/services/github/service/github-cli.service.ts`.
  - Auth: local `gh auth login`; no application env token is read for runtime GitHub access.
  - Repo config: `Project.githubOwner` and `Project.githubRepo` fields in `prisma/schema.prisma`.
  - Health checks: `githubCLIService.checkHealth()` in `src/backend/services/github/service/github-cli.service.ts` and combined CLI health in `src/backend/orchestration/cli-health.service.ts`.
  - API surfaces: `src/backend/trpc/github.trpc.ts`, `src/backend/trpc/pr-review.trpc.ts`, and PR snapshot logic in `src/backend/services/github/service/pr-snapshot.service.ts`.
  - Commands used: `gh api user`, `gh auth status`, `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr review`, `gh pr comment`, `gh search prs`, `gh issue list`, `gh issue view`, `gh issue comment`, and `gh issue close`.

**Linear:**
- Linear issue intake and lifecycle sync are supported per project.
  - SDK/Client: `@linear/sdk` via `LinearClient` in `src/backend/services/linear/service/linear-client.service.ts`.
  - Auth: per-project Linear API key stored in `Project.issueTrackerConfig` and decrypted by `cryptoService` in `src/backend/trpc/linear.trpc.ts`.
  - Config schema: `src/shared/schemas/issue-tracker-config.schema.ts`.
  - API surfaces: `src/backend/trpc/linear.trpc.ts` for validating keys, listing teams/issues, and fetching issue detail.
  - Lifecycle sync: `src/backend/services/linear/service/linear-state-sync.service.ts` marks issues `started` and `completed` best-effort.

**Claude Code Agent Runtime:**
- Claude agent sessions use the Agent Client Protocol with a Claude ACP adapter.
  - SDK/Client: `@agentclientprotocol/sdk` and `@agentclientprotocol/claude-agent-acp`.
  - Auth: local Claude CLI auth checked by `claude auth status --json` in `src/backend/orchestration/cli-health.service.ts`.
  - Runtime: ACP processes are spawned and managed in `src/backend/services/session/service/acp/acp-runtime-manager.ts`.
  - Config: default model/permission profile comes from `DEFAULT_MODEL` and `DEFAULT_PERMISSIONS` parsed in `src/backend/services/env-schemas.ts`.

**Codex Agent Runtime:**
- Codex agent sessions run through Factory Factory's internal ACP adapter, which bridges ACP to `codex app-server`.
  - SDK/Client: local `codex` CLI plus internal adapter in `src/backend/services/session/service/acp/codex-app-server-adapter/`.
  - Auth: local `codex login` checked with `codex login status` in `src/backend/orchestration/cli-health.service.ts`.
  - Adapter entrypoint: `src/cli/index.ts` command `internal codex-app-server-acp`.
  - App-server client: `src/backend/services/session/service/acp/codex-app-server-adapter/codex-rpc-client.ts` spawns `codex app-server`.
  - Schema drift tooling: `scripts/generate-codex-app-server-schemas.mjs`, `scripts/check-codex-schema-drift.mjs`, and snapshot `src/backend/services/session/service/acp/codex-app-server-adapter/schema-snapshots/app-server-methods.snapshot.json`.

**npm Registry:**
- CLI health checks query package freshness for Claude and Codex provider CLIs.
  - SDK/Client: native `fetch` in `src/backend/orchestration/cli-health.service.ts`.
  - Auth: none.
  - Endpoints: `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` and `https://registry.npmjs.org/@openai/codex/latest` are built from package names in `src/backend/orchestration/cli-health.service.ts`.

**Cloudflare Tunnel Tooling:**
- Docker image includes `cloudflared` for tunnel/proxy workflows and post-run log streaming.
  - SDK/Client: external `cloudflared` binary installed in `Dockerfile`.
  - Auth: not detected in application code.
  - Runtime support: post-run log WebSocket endpoint in `src/backend/routers/websocket/post-run-logs.handler.ts`; Docker env includes `CLOUD_MODE` in `docker-compose.yml`.

**Google Fonts:**
- Browser loads Geist, Geist Mono, Inter, and IBM Plex Mono from Google Fonts.
  - SDK/Client: `<link>` tags in `index.html`.
  - Auth: none.

## Data Storage

**Databases:**
- SQLite local file database.
  - Connection: `DATABASE_PATH` env var, or default `~/factory-factory/data.db` derived in `src/backend/lib/env.ts` and `src/backend/services/config.service.ts`.
  - Client: Prisma generated client `@prisma-gen/client` with `@prisma/adapter-better-sqlite3` in `src/backend/db.ts`.
  - Schema: `prisma/schema.prisma`.
  - Migrations: `prisma/migrations/`, configured in `prisma.config.ts`.
  - Runtime migration runner: `src/backend/migrate.ts` uses `better-sqlite3` directly for CLI/Electron startup.
  - Primary models: `Project`, `Workspace`, `AgentSession`, `TerminalSession`, `ClosedSession`, `UserSettings`, and `DecisionLog` in `prisma/schema.prisma`.

**File Storage:**
- Local filesystem only.
  - Base data directory: `BASE_DIR`, defaulting to `~/factory-factory`, in `src/backend/services/config.service.ts`.
  - Worktrees: `WORKTREE_BASE_DIR`, defaulting to `<baseDir>/worktrees`, in `src/backend/services/config.service.ts`.
  - Repos: `REPOS_DIR`, defaulting to `<baseDir>/repos`, in `src/backend/services/config.service.ts`.
  - Logs: `<baseDir>/logs/server.log` via `src/backend/services/logger.service.ts`.
  - ACP trace logs: `ACP_TRACE_LOGS_PATH` or `<baseDir>/debug/acp-events` via `src/backend/services/config.service.ts`.
  - WebSocket logs: `WS_LOGS_PATH` or `.context/ws-logs` via `src/backend/services/config.service.ts`.
  - Prompt templates: `prompts/` copied into `dist/` during `pnpm build`.
  - Electron production data: database and WebSocket logs under `app.getPath('userData')` in `electron/main/server-manager.ts`.

**Caching:**
- In-memory caches only.
  - GitHub CLI health and issue caches in `src/backend/services/github/service/github-cli.service.ts`.
  - CLI health cache in `src/backend/orchestration/cli-health.service.ts`.
  - React Query client cache in `src/client/lib/providers.tsx`.
  - No Redis, Memcached, or external cache service detected.

## Authentication & Identity

**Auth Provider:**
- No application user-login provider detected.
  - Implementation: local single-user/devtool style app; tRPC procedures use `publicProcedure` in `src/backend/trpc/*.trpc.ts`.
  - Project scoping: request headers `X-Project-Id` and `X-Top-Level-Task-Id` are read in `src/backend/trpc/trpc.ts`.

**External Auth:**
- GitHub auth uses the local GitHub CLI credential store; health check and calls are implemented in `src/backend/services/github/service/github-cli.service.ts`.
- Claude auth uses local Claude CLI state; checked in `src/backend/orchestration/cli-health.service.ts`.
- Codex auth uses local Codex CLI state; checked in `src/backend/orchestration/cli-health.service.ts`.
- Linear auth uses project-level API keys stored encrypted in SQLite and decrypted on demand in `src/backend/trpc/linear.trpc.ts`.

**Secret Storage:**
- Linear API keys are encrypted with AES-256-GCM in `src/backend/services/crypto.service.ts`.
- Encryption key is auto-generated at `<baseDir>/encryption.key` with mode `0600` by `src/backend/services/crypto.service.ts`.
- `.env.example` file present - contains sample environment configuration.

## Monitoring & Observability

**Error Tracking:**
- No external error tracking service detected.
- Server error responses and unhandled errors are handled in `src/backend/server.ts` and `src/backend/index.ts`.

**Logs:**
- Structured application logging is implemented in `src/backend/services/logger.service.ts`.
- Logs are written to `<baseDir>/logs/server.log`; development also pretty-prints to console, production writes JSON lines to file and errors to stderr.
- Session file logs and ACP trace logs are initialized through services wired in `src/backend/server.ts`.
- WebSocket log replay/streaming is supported by `src/backend/routers/websocket/dev-logs.handler.ts`, `src/backend/routers/websocket/post-run-logs.handler.ts`, and `src/backend/routers/websocket/snapshots.handler.ts`.

**Health Checks:**
- HTTP health endpoints are implemented in `src/backend/routers/health.router.ts`: `/health`, `/health/database`, and `/health/all`.
- Docker health check calls `http://localhost:7001/health` in `Dockerfile` and `docker-compose.yml`.
- Database connectivity health uses `healthService.checkDatabaseConnection()` from `src/backend/orchestration/health.service.ts`.
- CLI dependency health combines Claude, Codex, and GitHub checks in `src/backend/orchestration/cli-health.service.ts`.

## CI/CD & Deployment

**Hosting:**
- npm package distribution for the CLI app is configured in `package.json` and `.github/workflows/npm-publish.yml`.
- Docker image publishing to GHCR is configured in `.github/workflows/docker-publish.yml`; image name is `ghcr.io/purplefish-ai/factory-factory`.
- Docker runtime configuration is in `Dockerfile` and `docker-compose.yml`.
- Electron desktop artifacts are configured in `electron-builder.yml` and `.github/workflows/electron-release.yml`.
- Static frontend is served by the same Express backend in production from `FRONTEND_STATIC_PATH`, configured in `src/backend/server.ts`.

**CI Pipeline:**
- GitHub Actions CI in `.github/workflows/ci.yml`.
- CI jobs cover dependency install, Prisma client generation, migration diff, Biome check, import checks, dependency-cruiser, Knip, TypeScript, Codex schema drift, build, Storybook build, tests with coverage, and critical backend coverage.
- Docker publish workflow uses `docker/setup-buildx-action`, `docker/login-action`, `docker/metadata-action`, and `docker/build-push-action` in `.github/workflows/docker-publish.yml`.
- npm publish workflow uses npm provenance and `NODE_AUTH_TOKEN` secret name in `.github/workflows/npm-publish.yml`.
- Electron release workflow uploads macOS, Windows, and Linux artifacts in `.github/workflows/electron-release.yml`.

## Environment Configuration

**Required env vars:**
- None strictly required for local default startup; defaults are provided for database path, backend port, base directory, logging, CORS, and agent defaults in `src/backend/services/env-schemas.ts`.
- `DATABASE_PATH` - Override SQLite file path; used by `src/backend/lib/env.ts`, `src/backend/db.ts`, `src/cli/database-path.ts`, and `electron/main/server-manager.ts`.
- `BASE_DIR` - Override data root; used by `src/backend/services/config.service.ts`, `src/backend/lib/env.ts`, and `src/backend/services/logger.service.ts`.
- `WORKTREE_BASE_DIR` - Override workspace worktree root in `src/backend/services/config.service.ts`.
- `BACKEND_PORT` and `BACKEND_HOST` - Backend bind settings in `src/backend/services/config.service.ts` and `src/cli/index.ts`.
- `FRONTEND_STATIC_PATH` - Production SPA static root in `src/backend/server.ts`.
- `CORS_ALLOWED_ORIGINS` - Allowed browser origins in `src/backend/middleware/cors.middleware.ts`.
- `DEFAULT_MODEL` and `DEFAULT_PERMISSIONS` - Agent default session profile in `src/backend/services/config.service.ts`.
- `CLAUDE_CONFIG_DIR`, `ACP_STARTUP_TIMEOUT_MS`, `ACP_TRACE_LOGS_ENABLED`, `ACP_TRACE_LOGS_PATH`, `WS_LOGS_ENABLED`, and `FF_RUN_SCRIPT_PROXY_ENABLED` - ACP/runtime behavior in `src/backend/services/config.service.ts`.
- `BACKEND_URL`, `VITE_BASE_PATH`, `DEBUG_CHAT_WS`, and `VITE_ENABLE_MOBILE_BASELINE` - Vite/client behavior in `vite.config.ts`, `src/lib/debug.ts`, and `src/client/router.tsx`.

**Secrets location:**
- Local CLI credentials for GitHub, Claude, and Codex live in each tool's native credential store; app code checks health but does not read those credential files directly.
- Linear API keys are encrypted into the SQLite `Project.issueTrackerConfig` JSON field and decrypted with `src/backend/services/crypto.service.ts`.
- Encryption key file lives at `<baseDir>/encryption.key`; do not commit or copy this file.
- GitHub Actions secret names referenced: `secrets.GITHUB_TOKEN` in `.github/workflows/docker-publish.yml` and `secrets.NPM_TOKEN` in `.github/workflows/npm-publish.yml`.

## Webhooks & Callbacks

**Incoming:**
- No third-party webhook receiver endpoints detected.
- HTTP endpoints are local app endpoints: `/health`, `/health/database`, `/health/all`, `/api/trpc`, and production SPA fallback in `src/backend/server.ts`.
- WebSocket endpoints are `/chat`, `/terminal`, `/setup-terminal`, `/dev-logs`, `/post-run-logs`, and `/snapshots` in `src/backend/server.ts`.
- tRPC routers expose app operations through `src/backend/trpc/index.ts`, including `github`, `linear`, `prReview`, `workspace`, `session`, `project`, `admin`, `closedSessions`, `decisionLog`, `userSettings`, and `autoIteration`.

**Outgoing:**
- GitHub CLI calls to GitHub APIs through `gh` in `src/backend/services/github/service/github-cli.service.ts`.
- Linear GraphQL/API calls through `@linear/sdk` in `src/backend/services/linear/service/linear-client.service.ts`.
- npm registry fetches for CLI latest-version checks in `src/backend/orchestration/cli-health.service.ts`.
- Browser font requests to Google Fonts from `index.html`.
- Optional desktop notification subprocesses use platform tools in `src/backend/services/notification.service.ts`.
- Agent subprocesses spawn local `claude`, `codex`, and internal ACP adapter commands through `src/backend/services/session/service/acp/acp-runtime-manager.ts` and `src/backend/services/session/service/acp/codex-app-server-adapter/codex-rpc-client.ts`.

---

*Integration audit: 2026-04-29*
