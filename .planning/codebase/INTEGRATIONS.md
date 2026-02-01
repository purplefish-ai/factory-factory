# External Integrations

**Analysis Date:** 2026-02-01

## APIs & External Services

**GitHub Integration:**
- **GitHub CLI (gh)** - Local authentication for PR/repository operations
  - Service: GitHub.com
  - Access: Via locally authenticated `gh` CLI command (no API tokens required)
  - Implementation: `src/backend/services/github-cli.service.ts`
  - Functions: Fetch PR status, CI status, review decisions, PR metadata
  - Auth: OAuth via `gh auth login` (user's local credentials)

**Claude AI Integration:**
- **Claude CLI** - Local Claude Code sessions via streaming JSON protocol
  - Service: Anthropic Claude API (via Claude CLI)
  - Access: Via Claude CLI process spawned in workspace
  - Implementation: `src/backend/claude/` (index.ts, process.ts, protocol.ts, session.ts)
  - Session Management: `src/backend/claude/session.ts` (reads ~/.claude/projects/)
  - Auth: OAuth via `claude login` (user's local credentials, no API keys needed)
  - Protocol: Custom streaming JSON protocol with permission handlers
  - Models: Configurable (sonnet, opus, haiku) via env var
  - Features: Tool use, extended thinking, hooks (PreToolUse, Stop), session resume/fork

## Data Storage

**Databases:**
- **SQLite 3**
  - Provider: Local file-based database
  - Location: `~/factory-factory/data.db` (or `DATABASE_PATH` env var)
  - Electron: `~/Library/Application Support/Factory Factory/data.db` (macOS)
  - Client: Prisma ORM with `@prisma/adapter-better-sqlite3`
  - Driver: better-sqlite3 (synchronous, high-performance)
  - Migrations: Prisma migrations in `prisma/migrations/`
  - Schema: `prisma/schema.prisma` - Models for Project, Workspace, ClaudeSession, TerminalSession, DecisionLog, UserSettings

**File Storage:**
- **Local filesystem only** - No cloud storage integration
  - Worktree directories: `WORKTREE_BASE_DIR/workspace-{id}/` (git repositories)
  - Session logs: `BASE_DIR/worktrees/` structure
  - Prisma migrations: `prisma/migrations/` (committed to repo)

**Caching:**
- **In-memory only** - No Redis or external cache
  - TanStack React Query client-side cache
  - Message queue service for rate limiting: `src/backend/services/message-queue.service.ts`

## Authentication & Identity

**Auth Provider:**
- **Custom OAuth flows via CLI tools**
  - GitHub: OAuth via `gh` CLI (user runs `gh auth login`)
  - Claude: OAuth via Claude CLI (user runs `claude login`)
  - No built-in authentication - delegates to local CLI tools

**Implementation:**
- `src/backend/services/github-cli.service.ts` - Validates gh CLI is installed and authenticated
- `src/backend/claude/` - Validates Claude CLI is installed and accessible
- Feature flag available: `FEATURE_AUTHENTICATION=false` (default, for future multi-user support)

## Monitoring & Observability

**Error Tracking:**
- None configured (feature flag: `FEATURE_ERROR_TRACKING=false`)
- Could integrate with Sentry or similar via feature flag

**Logs:**
- **File-based logging**
  - Logger: `src/backend/services/logger.service.ts`
  - Environment: `LOG_LEVEL=info` (configurable: error/warn/info/debug)
  - Service name: `SERVICE_NAME=factoryfactory`
  - Session logs: `src/backend/services/session-file-logger.service.ts` - Logs Claude session output to files

**Metrics:**
- Disabled by default: `FEATURE_METRICS=false`
- Prometheus metrics could be enabled via feature flag
- Process monitoring: `pidusage` 4.0.1 - Process resource usage tracking

**Health Checks:**
- Internal health check router: `src/backend/routers/api/health.router.ts`
- CLI health service: `src/backend/services/cli-health.service.ts` - Validates Claude CLI and gh CLI
- WebSocket heartbeat: 30-second ping/pong interval
- Reconciliation service: `src/backend/services/reconciliation.service.ts` - Workspace state sync
- Scheduler service: `src/backend/services/scheduler.service.ts` - PR status polling, health checks

## CI/CD & Deployment

**Hosting:**
- **Electron Desktop** - macOS, Windows, Linux native apps
- **Web/CLI Mode** - Express server + React frontend + Electron optional
- Deployment: Manual (electron-builder) or Docker containers

**CI Pipeline:**
- None configured in codebase
- GitHub Actions available (see git history for references)
- Pre-commit hooks via Husky: `husky` 9.1.7

**Build Artifacts:**
- `dist/src/backend/` - Compiled backend TypeScript
- `dist/client/` - Compiled Vite frontend
- `dist/prisma/generated/` - Prisma client
- `dist/electron/` - Compiled Electron main process
- Release packages: DMG (macOS), NSIS (Windows), AppImage/deb (Linux)

## Environment Configuration

**Required env vars:**
- `DATABASE_PATH` - SQLite database location
- `BACKEND_PORT` - Server port (default: 4001)
- `BACKEND_URL` - For frontend to reach backend (dev only)
- `NODE_ENV` - development or production
- `LOG_LEVEL` - Logging verbosity

**Optional env vars:**
- `ORCHESTRATOR_MODEL`, `SUPERVISOR_MODEL`, `WORKER_MODEL` - Claude model selection
- `ORCHESTRATOR_PERMISSIONS`, `SUPERVISOR_PERMISSIONS`, `WORKER_PERMISSIONS` - Permission modes
- `MAX_SESSIONS_PER_WORKSPACE` - Rate limiting
- `CLAUDE_RATE_LIMIT_PER_MINUTE`, `CLAUDE_RATE_LIMIT_PER_HOUR` - API rate limits
- `HEALTH_CHECK_INTERVAL_MS` - Health check frequency
- `NOTIFICATION_PUSH_ENABLED`, `NOTIFICATION_SOUND_ENABLED` - Desktop notifications
- `CORS_ALLOWED_ORIGINS` - CORS configuration

**Secrets location:**
- No external secrets (all in local .env file)
- GitHub auth via `gh` CLI (no tokens in .env)
- Claude auth via Claude CLI (no API keys in .env)
- `.env` file should be added to `.gitignore` (not committed)

## Webhooks & Callbacks

**Incoming:**
- None - No external webhooks consumed

**Outgoing:**
- None currently implemented
- GitHub PR updates are polled, not webhook-based

**Real-time Communication:**
- WebSocket endpoints (internal only):
  - `/chat` - Claude Code session streaming (JSON protocol)
  - `/terminal` - PTY terminal sessions (xterm.js protocol)
  - `/dev-logs` - Development logs streaming
  - All routes authenticated via tRPC context

## Git Integration

**Git Operations:**
- Local git command execution via `src/backend/clients/git.client.ts`
- Worktree management: Create, switch branches, push/pull
- PR detection from branch names and remote tracking
- Branch rename tracking via interceptor: `src/backend/interceptors/branch-rename.interceptor.ts`
- Uses system `git` command (no git library dependencies)

## MCP (Model Context Protocol)

**MCP Server:**
- Integrated MCP server for Claude CLI: `src/backend/routers/mcp/server.ts`
- Tools exposed:
  - Terminal MCP tool: `src/backend/routers/mcp/terminal.mcp.ts` - Execute commands in workspace
  - System MCP tool: `src/backend/routers/mcp/system.mcp.ts` - System operations
  - Lock MCP tool: `src/backend/routers/mcp/lock.mcp.ts` - Resource locking

## Rate Limiting

**Claude API:**
- Rate limiter service: `src/backend/services/rate-limiter.service.ts`
- Limits: Configurable per-minute and per-hour
- Queue size: 100 requests (timeout: 30 seconds)
- Max concurrent sessions: 5 per workspace

---

*Integration audit: 2026-02-01*
