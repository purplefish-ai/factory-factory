# External Integrations

**Analysis Date:** 2026-02-09

## APIs & External Services

**GitHub:**
- GitHub CLI (`gh`) integration via local authentication
- Service: `src/backend/services/github-cli.service.ts`
- Purpose: Fetch PR details, review state, CI status, issue information
- Auth: Uses local `gh` command-line authentication (not API key)
- Features:
  - PR metadata: state (OPEN/CLOSED/MERGED), review decision, CI status
  - Issue fetching for workspace creation
  - Review comment tracking and monitoring
  - Merge state and conflict detection

**Claude API:**
- SDK/Client: Claude CLI process communication (not SDK)
- Service: `src/backend/claude/` (protocol, process management, permissions)
- Auth: Uses local `claude` CLI authentication via OAuth
- Communication: NDJSON bidirectional protocol over stdin/stdout
- Purpose: Execute code generation and analysis tasks

**Git (local):**
- Git command execution
- Service: `src/backend/clients/git.client.ts`, `src/backend/lib/git-helpers.ts`, `src/backend/services/git-ops.service.ts`
- Purpose: Worktree management, branch operations, push/pull, commit history
- Command execution: Via Node.js `child_process.execFile`

## Data Storage

**Databases:**
- SQLite (local file-based)
  - Connection: `src/backend/db.ts`
  - Client: `@prisma/client` via `PrismaBetterSqlite3` adapter
  - Path: `$DATABASE_PATH` or `~/factory-factory/data.db` (configurable)
  - Schema: `prisma/schema.prisma`
  - Migrations: `prisma/migrations/`
  - Tables: Project, Workspace, ClaudeSession, TerminalSession, UserSettings, DecisionLog, Ratchet state tracking

**File Storage:**
- Local filesystem only
  - Worktree directories: `$WORKTREE_BASE_DIR` or `$BASE_DIR/worktrees`
  - Debug logs: `$BASE_DIR` (project-specific paths)
  - Prompt templates: `prompts/` directory (copied to `dist/` on build)
  - Database file: `~/factory-factory/data.db` (or configured via `DATABASE_PATH`)

**Caching:**
- In-memory: tRPC and React Query manage request caching
- WebSocket subscriptions: Real-time event forwarding via `ws` library
- Session store: `src/backend/services/session-store.service.ts`

## Authentication & Identity

**Auth Provider:**
- Custom (via CLI authentication)
  - Claude: OAuth via `claude login` command
  - GitHub: OAuth via `gh auth login` command
  - Implementation: Local CLI tool authentication, not API-based
  - No application-level authentication on the server (single-user local app)

**Session Management:**
- Claude sessions tracked in database: `ClaudeSession` table
- Session resume capability via `claudeSessionId` and `claudeProjectPath`
- Process management: `src/backend/claude/process.ts`
- WebSocket session tracking: `src/backend/services/session-store.service.ts`

## Monitoring & Observability

**Error Tracking:**
- Not integrated
- Feature flag: `FEATURE_ERROR_TRACKING` (default: false)
- Local logging only: `src/backend/services/logger.service.ts`

**Logs:**
- Console logging with levels: error, warn, info, debug
- Configurable via `LOG_LEVEL` env var (default: info)
- Service name: `SERVICE_NAME` env var (default: factoryfactory)
- WebSocket session logs: Optional via `WS_LOGS_ENABLED` and `WS_LOGS_PATH`
- Debug utilities: `src/lib/debug.ts` for development

**Performance Monitoring:**
- Feature flag: `FEATURE_METRICS` (default: false)
- Health checks: `src/backend/routers/api/health.router.ts`
- System resource usage: `pidusage` package for process metrics

## CI/CD & Deployment

**Hosting:**
- Standalone CLI: `ff` or `factory-factory` commands
- Electron desktop app: macOS, Windows, Linux via electron-builder
- Server mode: Listens on `BACKEND_PORT` with tRPC + REST API
- Frontend: Vite SPA served alongside backend

**CI Pipeline:**
- No explicit CI configured
- Health checks and monitoring: `src/backend/services/cli-health.service.ts`
- PR ratchet system: Auto-checks PR state and CI status (`src/backend/services/ratchet.service.ts`)
- Scheduler: `src/backend/services/scheduler.service.ts` for background tasks

**Build & Packaging:**
- Backend: TypeScript compiled to `dist/`
- Frontend: Vite build to `dist/client/`
- Electron: electron-builder packages for distribution
- Rebuild: `electron-rebuild` for native modules in Electron context

## Environment Configuration

**Required env vars:**
- `DATABASE_PATH` (optional, defaults to `~/factory-factory/data.db`)
- `NODE_ENV` (default: development)

**Optional env vars:**
- `BACKEND_PORT` (default: 3001 dev / 4001 config)
- `FRONTEND_PORT` (default: 4000)
- `BACKEND_URL` (default: http://localhost:3000)
- `BASE_DIR` (default: ~/factory-factory)
- `WORKTREE_BASE_DIR` (defaults to $BASE_DIR/worktrees)
- `LOG_LEVEL` (default: info)
- `SERVICE_NAME` (default: factoryfactory)
- `CORS_ALLOWED_ORIGINS` (default: dev ports 3000/3001/4000/4001)
- Agent configuration:
  - `ORCHESTRATOR_MODEL`, `SUPERVISOR_MODEL`, `WORKER_MODEL`
  - `ORCHESTRATOR_PERMISSIONS`, `SUPERVISOR_PERMISSIONS`, `WORKER_PERMISSIONS`
  - `CLAUDE_RATE_LIMIT_PER_MINUTE`, `CLAUDE_RATE_LIMIT_PER_HOUR`
  - `MAX_SESSIONS_PER_WORKSPACE`
  - `MAX_WORKER_ATTEMPTS`, `CRASH_LOOP_THRESHOLD_MS`, `MAX_RAPID_CRASHES`

**Secrets location:**
- `.env` file (not committed, see `.env.example` for template)
- Electron: DATABASE_PATH set by app process
- GitHub auth: Local `~/.config/gh/config.yml` (managed by `gh` CLI)
- Claude auth: Local `~/.claude/` (managed by `claude` CLI)

## Webhooks & Callbacks

**Incoming:**
- None explicit - single-user desktop app
- Health check endpoint: `GET /api/health`

**Outgoing:**
- PR/CI monitoring callbacks: Periodic polling via scheduler service
  - Check PR state every minute (configurable)
  - Poll CI status via GitHub CLI
  - Ratchet state machine triggers fixer sessions
- WebSocket event broadcasts:
  - Chat events: `/chat` endpoint
  - Terminal events: `/terminal` endpoint
  - Dev logs: `/dev-logs` endpoint (run script output streaming)

## Model Container Protocol (MCP)

**Purpose:** Tool/resource access for Claude agents

**Tools available:**
- `src/backend/routers/mcp/terminal.mcp.ts` - Terminal command execution
- `src/backend/routers/mcp/system.mcp.ts` - System information
- `src/backend/routers/mcp/lock.mcp.ts` - Session-level mutual exclusion

**Implementation:** MCP server wrapper in `src/backend/routers/mcp/server.ts`
- Tool execution with retry logic
- Request/response validation via Zod schemas
- Error handling specific to tool failures

---

*Integration audit: 2026-02-09*
