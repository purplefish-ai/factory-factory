# External Integrations

**Analysis Date:** 2026-05-17

## APIs & External Services

**GitHub:**
- GitHub API through the local `gh` CLI - PR status, PR details, review comments, issue intake, issue comments, approvals, and issue closing
  - SDK/Client: `gh` subprocess calls in `src/backend/services/github/service/github-cli.service.ts`
  - Auth: local GitHub CLI auth (`gh auth login` / `gh auth status`), checked by `src/backend/services/github/service/github-cli.service.ts` and `src/backend/orchestration/cli-health.service.ts`
  - Related storage: GitHub project and workspace fields in `prisma/schema.prisma` (`githubOwner`, `githubRepo`, `githubIssueNumber`, `githubIssueUrl`, `prUrl`, `prNumber`, PR/CI/review status fields)
- GitHub repository cloning - accepts HTTPS and SSH GitHub URLs and runs `git clone`
  - SDK/Client: `git` and `gh` subprocesses in `src/backend/services/git-clone.service.ts`
  - Auth: local Git/SSH credentials or GitHub CLI auth, depending on clone URL and local environment

**Linear:**
- Linear API - per-project team configuration, key validation, assigned issue intake, issue detail fetch, and lifecycle state transitions
  - SDK/Client: `@linear/sdk` via `LinearClient` in `src/backend/services/linear/service/linear-client.service.ts`
  - Auth: per-project Linear API key stored in `Project.issueTrackerConfig` and decrypted by `src/backend/orchestration/linear-config.helper.ts`
  - Key storage: plaintext key is accepted by `src/backend/trpc/linear.trpc.ts`, encrypted before persistence by `src/backend/trpc/project.trpc.ts`, and sanitized before client return by `src/shared/schemas/issue-tracker-config.schema.ts`

**Agent Runtimes:**
- Agent Client Protocol (ACP) - unified provider session protocol for Claude and Codex agent sessions
  - SDK/Client: `@agentclientprotocol/sdk` in `src/backend/services/session/service/acp/`
  - Auth: delegated to provider CLI auth state
  - Transport: stdio NDJSON between backend and provider adapter subprocesses in `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- Claude Code - provider runtime through `claude-agent-acp`
  - SDK/Client: `@agentclientprotocol/claude-agent-acp` binary resolved by `src/backend/services/session/service/acp/acp-runtime-manager.ts`
  - Auth: local `claude auth status --json`, checked by `src/backend/orchestration/cli-health.service.ts`
  - Config: `CLAUDE_CONFIG_DIR`, provider model/mode config options, and workspace permission presets from `src/backend/services/config.service.ts`
- Codex - provider runtime through Factory Factory's internal ACP adapter wrapping `codex app-server`
  - SDK/Client: internal command `ff internal codex-app-server-acp` in `src/cli/index.ts`, adapter in `src/backend/services/session/service/acp/codex-app-server-adapter/`, and `codex app-server` subprocess in `src/backend/services/session/service/acp/codex-app-server-adapter/codex-rpc-client.ts`
  - Auth: local `codex login status`, checked by `src/backend/orchestration/cli-health.service.ts`
  - Schema drift guard: `scripts/check-codex-schema-drift.mjs` and snapshot `src/backend/services/session/service/acp/codex-app-server-adapter/schema-snapshots/app-server-methods.snapshot.json`

**Cloudflare Tunnel:**
- Cloudflare quick tunnels - public access for whole-app proxy mode and optional run-script preview tunnels
  - SDK/Client: `cloudflared tunnel --url` subprocess launched through `src/shared/proxy-utils.ts`
  - Auth: unauthenticated trycloudflare quick tunnel; app-layer password/token protection is implemented in `src/cli/proxy.ts` and `src/backend/services/run-script-proxy.service.ts`
  - Docker install: `Dockerfile` downloads `cloudflared` into `/usr/local/bin/cloudflared`

**npm Registry:**
- npm package metadata lookup - checks latest Claude/Codex CLI package versions
  - SDK/Client: `fetch("https://registry.npmjs.org/.../latest")` in `src/backend/orchestration/cli-health.service.ts`
  - Auth: none for latest-version reads
- npm publishing - publishes package artifacts
  - SDK/Client: `npm publish` in `.github/workflows/npm-publish.yml`
  - Auth: `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`

**GHCR / GitHub Actions:**
- GitHub Container Registry - Docker image publishing
  - SDK/Client: Docker Buildx actions in `.github/workflows/docker-publish.yml`
  - Auth: `secrets.GITHUB_TOKEN` through the workflow's `packages: write` permission
- GitHub Releases - Electron artifact release upload and optional npm workflow release creation
  - SDK/Client: `softprops/action-gh-release` in `.github/workflows/electron-release.yml` and `.github/workflows/npm-publish.yml`
  - Auth: workflow `contents: write` permission

**Local OS / Process Integrations:**
- Git - repository validation, worktree management, commits, branch checks, clone operations
  - SDK/Client: subprocess calls in `src/backend/lib/shell.ts`, `src/backend/services/git-ops.service.ts`, `src/backend/services/git-clone.service.ts`, and `src/backend/clients/git.client.ts`
  - Auth: local Git credential/SSH setup
- PTY terminals - browser terminal sessions backed by local shell processes
  - SDK/Client: `node-pty` loaded in `src/backend/services/terminal/service/terminal.service.ts`
  - Auth: local OS user permissions
- Desktop notifications and sounds - local macOS/Linux/Windows notification tools
  - SDK/Client: `osascript`, `notify-send`, `zenity`, PowerShell, `afplay`, `paplay`, and `aplay` subprocesses in `src/backend/services/notification.service.ts`
  - Auth: local OS notification permissions
- Electron desktop shell - native window, file dialog, and in-process backend lifecycle
  - SDK/Client: Electron APIs in `electron/main/index.ts`, `electron/main/lifecycle.ts`, `electron/main/server-manager.ts`, and `electron/preload/index.ts`
  - Auth: local app execution context

## Data Storage

**Databases:**
- SQLite database
  - Connection: `DATABASE_PATH` or `BASE_DIR`; default path is resolved to `~/factory-factory/data.db` by `src/backend/lib/env.ts`
  - Client: Prisma generated client from `prisma/schema.prisma`, used through `@prisma-gen/client` and `PrismaBetterSqlite3` in `src/backend/db.ts`
  - Migrations: `prisma/migrations/`, `src/backend/migrate.ts`, CLI `ff db:migrate`, and `prisma.config.ts`

**File Storage:**
- Local filesystem only
  - Logs: structured server logs at `{BASE_DIR}/logs/server.log` through `src/backend/services/logger.service.ts`
  - ACP trace logs: path from `ACP_TRACE_LOGS_PATH` or `{BASE_DIR}/debug/acp-events` through `src/backend/services/config.service.ts`
  - WebSocket/session debug logs: `WS_LOGS_PATH` or `.context/ws-logs` through `src/backend/services/session/service/logging/session-file-logger.service.ts`
  - Closed-session transcripts: `ClosedSession.transcriptPath` in `prisma/schema.prisma`, written by `src/backend/services/session/service/lifecycle/closed-session-persistence.service.ts`
  - Worktrees/repos: `WORKTREE_BASE_DIR` and `REPOS_DIR` from `src/backend/services/config.service.ts`
  - Encryption key: `{BASE_DIR}/encryption.key` created by `src/backend/services/crypto.service.ts`
  - Electron data: Electron `userData` path for SQLite and WebSocket logs in `electron/main/server-manager.ts`

**Caching:**
- In-memory caches only
  - GitHub CLI health and issue cache in `src/backend/services/github/service/github-cli.service.ts`
  - CLI health cache in `src/backend/orchestration/cli-health.service.ts`
  - Workspace snapshot in-memory store in `src/backend/services/workspace-snapshot-store.service.ts`
  - Session/runtime maps in `src/backend/services/session/service/acp/acp-runtime-manager.ts`
  - Terminal and run-script output buffers in `src/backend/services/terminal/service/terminal.service.ts` and `src/backend/services/run-script/service/run-script.service.ts`
- External cache service: Not detected

## Authentication & Identity

**Auth Provider:**
- No app-level user authentication provider is detected; backend tRPC procedures use `publicProcedure` and project scoping headers in `src/backend/trpc/`
  - Implementation: local single-user workstation/server model with provider-specific CLI/API credentials
- GitHub identity uses local `gh` authentication
  - Implementation: `gh auth status`, `gh api user`, and `gh` PR/issue commands in `src/backend/services/github/service/github-cli.service.ts`
- Claude identity uses local Claude CLI authentication
  - Implementation: `claude auth status --json` in `src/backend/orchestration/cli-health.service.ts`
- Codex identity uses local Codex CLI authentication
  - Implementation: `codex login status` in `src/backend/orchestration/cli-health.service.ts`
- Linear identity uses project-level API keys
  - Implementation: AES-256-GCM encryption/decryption in `src/backend/services/crypto.service.ts`; encrypted config stored in `Project.issueTrackerConfig`
- Public proxy auth uses generated app-layer token/password sessions
  - Implementation: HMAC-signed cookies, constant-time token checks, and brute-force guard in `src/shared/proxy-utils.ts` and `src/cli/proxy.ts`
- Run-script proxy auth uses generated token links and signed cookies
  - Implementation: `src/backend/services/run-script-proxy.service.ts`

## Monitoring & Observability

**Error Tracking:**
- External error tracking service: Not detected
- Local logging uses structured JSON log files and pretty console output via `src/backend/services/logger.service.ts`

**Logs:**
- Server logs: `{BASE_DIR}/logs/server.log` from `src/backend/services/logger.service.ts`
- Session/WebSocket logs: optional per-session files from `src/backend/services/session/service/logging/session-file-logger.service.ts`
- ACP trace logs: optional ACP event logs from `src/backend/services/session/service/logging/acp-trace-logger.service.ts`
- Run-script logs: in-memory output buffers and WebSocket streaming from `src/backend/services/run-script/service/run-script.service.ts`
- Terminal logs: rolling PTY output buffers from `src/backend/services/terminal/service/terminal.service.ts`
- Health endpoints: `/health` and `/health/all` from `src/backend/routers/health.router.ts`

## CI/CD & Deployment

**Hosting:**
- Local CLI server: `ff serve` / `pnpm start`, implemented by `src/cli/index.ts` and `src/backend/server.ts`
- Docker image: `Dockerfile`, `docker-compose.yml`, and GHCR publishing in `.github/workflows/docker-publish.yml`
- Electron desktop app: `electron/`, `electron-builder.yml`, and `.github/workflows/electron-release.yml`
- npm package: package binaries in `package.json`, publish workflow in `.github/workflows/npm-publish.yml`

**CI Pipeline:**
- GitHub Actions
  - CI checks/build/storybook/test: `.github/workflows/ci.yml`
  - Docker image publishing: `.github/workflows/docker-publish.yml`
  - npm publishing: `.github/workflows/npm-publish.yml`
  - Electron artifact builds/releases: `.github/workflows/electron-release.yml`

## Environment Configuration

**Required env vars:**
- Hard required for default local startup: none detected; config has defaults for database path, backend port, base directories, logging, and runtime limits in `src/backend/services/env-schemas.ts`
- Important runtime overrides: `DATABASE_PATH`, `BASE_DIR`, `WORKTREE_BASE_DIR`, `REPOS_DIR`, `BACKEND_PORT`, `BACKEND_HOST`, `FRONTEND_STATIC_PATH`, `MIGRATIONS_PATH`, `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`, `SERVICE_NAME`, `NODE_ENV`, `SHELL`
- Agent/runtime controls: `DEFAULT_MODEL`, `DEFAULT_PERMISSIONS`, `ACP_STARTUP_TIMEOUT_MS`, `ACP_TRACE_LOGS_ENABLED`, `ACP_TRACE_LOGS_PATH`, `CLAUDE_CONFIG_DIR`, `MAX_SESSIONS_PER_WORKSPACE`, `DEBUG_CHAT_WS`
- Logging/proxy controls: `WS_LOGS_ENABLED`, `WS_LOGS_PATH`, `FF_RUN_SCRIPT_PROXY_ENABLED`, `EVENT_COMPRESSION_ENABLED`
- Notification controls: `NOTIFICATION_SOUND_ENABLED`, `NOTIFICATION_PUSH_ENABLED`, `NOTIFICATION_SOUND_FILE`, `NOTIFICATION_QUIET_HOURS_START`, `NOTIFICATION_QUIET_HOURS_END`
- Rate/queue controls: `CLAUDE_RATE_LIMIT_PER_MINUTE`, `CLAUDE_RATE_LIMIT_PER_HOUR`, `RATE_LIMIT_QUEUE_SIZE`, `RATE_LIMIT_QUEUE_TIMEOUT_MS`
- Docker compose controls: `PORT`, `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`, `CLOUD_MODE` in `docker-compose.yml`
- CI secrets: `secrets.GITHUB_TOKEN` for GHCR/GitHub release operations and `secrets.NPM_TOKEN` for npm publishing in `.github/workflows/`

**Secrets location:**
- `.env.example` exists for environment documentation; mapper did not read env file contents
- Linear API keys are encrypted before database persistence using `src/backend/services/crypto.service.ts`; the AES key is stored locally at `{BASE_DIR}/encryption.key`
- GitHub, Claude, Codex, Git, and npm credentials are external to the app and managed by local CLIs or GitHub Actions secrets

## Webhooks & Callbacks

**Incoming:**
- External webhook endpoints: Not detected
- Internal HTTP endpoints: `/health`, `/health/all`, and `/api/trpc` are mounted in `src/backend/server.ts`
- WebSocket upgrade endpoints: `/chat`, `/terminal`, `/setup-terminal`, `/dev-logs`, `/post-run-logs`, and `/snapshots` are handled in `src/backend/server.ts` and `src/backend/routers/websocket/`
- Proxy login callback path: `/__proxy_auth/login` in `src/cli/proxy.ts`

**Outgoing:**
- GitHub API calls through `gh` subprocesses in `src/backend/services/github/service/github-cli.service.ts`
- Linear API calls through `@linear/sdk` in `src/backend/services/linear/service/linear-client.service.ts`
- Cloudflare quick tunnel subprocesses through `cloudflared` in `src/shared/proxy-utils.ts`
- npm registry latest-version reads in `src/backend/orchestration/cli-health.service.ts`
- Local provider subprocesses: `claude-agent-acp`, internal Codex ACP adapter, `codex app-server`, `git`, `gh`, shell commands, notification commands, and run scripts across `src/backend/services/` and `src/cli/`

---

*Integration audit: 2026-05-17*
