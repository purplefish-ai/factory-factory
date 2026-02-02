# External Integrations

**Analysis Date:** 2026-02-01

## APIs & External Services

**Claude API:**
- Service: Anthropic Claude AI API
- What it's used for: Core LLM functionality for code generation and analysis in Claude Code sessions
- SDK/Client: Custom ClaudeClient wrapper at `src/backend/claude/index.ts`
- Auth: OAuth via `claude login` CLI command (no API key stored in app)
- Integration type: Process-based spawning of Claude CLI (`/usr/local/bin/claude` on macOS)
- Session management: `src/backend/claude/session.ts` - Reads session history from `~/.claude/projects/`
- Protocol: Streaming JSON protocol for bidirectional communication

**GitHub CLI Integration:**
- Service: GitHub (via locally-authenticated `gh` CLI)
- What it's used for: PR detection, PR state fetching, CI status, branch operations, code review data
- SDK/Client: `src/backend/services/github-cli.service.ts`
- Auth: Local authentication via `gh auth login` (leverages system git config)
- Integration type: Shell command execution (no direct API tokens stored)
- Capabilities:
  - Fetch PR status and review decisions
  - Detect pull requests from commit messages
  - Get CI status rollup
  - Fetch review-requested PRs
  - Verify authentication and CLI availability
- Error handling: Detects auth_required, cli_not_installed, network_error states

**Git Operations:**
- Service: Local git repositories and GitHub (via `git` and `gh` commands)
- What it's used for: Worktree creation, branch management, PR operations
- SDK/Client: `src/backend/clients/git.client.ts`
- Auth: System git credentials (SSH keys or HTTPS tokens)
- Integration type: Shell commands
- Capabilities:
  - Create git worktrees with auto-generated branch names
  - Fetch from remote before branching
  - List and manage worktrees
  - Push branches and create PRs

## Data Storage

**Databases:**
- Type/Provider: SQLite (embedded)
- Connection: `better-sqlite3` C++ bindings
- Client: `@prisma/client` via ORM
- Adapter: `@prisma/adapter-better-sqlite3`
- Location: Environment-configurable via `DATABASE_PATH` env var
  - Default: `~/factory-factory/data.db`
  - Electron: `app.getPath('userData')/data.db` (OS-specific)
- Schema: `prisma/schema.prisma` (Prisma schema)
- Generated client: `prisma/generated/client`
- Migrations: `prisma/migrations/` (committed to repo)

**File Storage:**
- Type: Local filesystem only
- Locations:
  - Worktrees: `WORKTREE_BASE_DIR` (default: `~/factory-factory/worktrees`)
  - Session logs: Stored per-workspace
  - Database: `DATABASE_PATH` or `~/factory-factory/data.db`
  - Claude history: System location `~/.claude/projects/`

**Caching:**
- In-memory caching of:
  - GitHub authenticated username (cached once per server lifetime in `src/backend/trpc/workspace/init.trpc.ts`)
  - Git branch existence checks
  - API call rate limiting state

## Authentication & Identity

**Auth Provider:**
- Custom/Multiple providers:
  - Claude: OAuth via `claude login` (handled outside app, uses system auth)
  - GitHub: Local `gh` CLI authentication (system-managed, accessed via shell)
  - Git: System SSH keys or HTTPS credentials (OS-managed)

**Implementation:**
- No built-in authentication system for app users
- FEATURE_AUTHENTICATION flag disabled by default (in `.env.example`)
- Session-based access: ClaudeSession tracks individual Claude Code conversations
- Permission model: Three levels enforced per session
  - strict: Requires approval for each tool
  - relaxed: Auto-approves with logging
  - yolo: Auto-approves everything
- Workspace isolation: Each workspace is isolated git worktree with independent session

## Monitoring & Observability

**Error Tracking:**
- FEATURE_ERROR_TRACKING flag disabled by default (in `.env.example`)
- No external error tracking service configured
- Errors logged locally via custom logger service

**Logs:**
- Approach: Custom `createLogger` service (`src/backend/services/logger.service.ts`)
- Log levels: error, warn, info, debug
- Log level configured via `LOG_LEVEL` env var (default: info)
- Service name: `SERVICE_NAME` env var (default: factoryfactory)
- Output: Console (stdout/stderr)
- Session file logging: Per-session logs via `src/backend/services/session-file-logger.service.ts`
- Terminal device logs: WebSocket stream to frontend for real-time viewing

**Health Checks:**
- Health endpoint: `GET /health`
- Metrics: Rate limiter API usage stats, request counts
- Interval: `HEALTH_CHECK_INTERVAL_MS` env var (default: 300000ms = 5min)
- Agent heartbeat monitoring: `AGENT_HEARTBEAT_THRESHOLD_MINUTES` (default: 7min)

## Rate Limiting & Quotas

**Claude API Rate Limits:**
- Configuration: `CLAUDE_RATE_LIMIT_PER_MINUTE` (default: 60)
- Configuration: `CLAUDE_RATE_LIMIT_PER_HOUR` (default: 1000)
- Queue settings: `RATE_LIMIT_QUEUE_SIZE` (default: 100), `RATE_LIMIT_QUEUE_TIMEOUT_MS` (default: 30000ms)
- Implementation: `src/backend/services/rate-limiter.service.ts`
- Enforcement: Queues requests when limit reached

**Session Limits:**
- Max sessions per workspace: `MAX_SESSIONS_PER_WORKSPACE` (default: 5)
- Tracked in database and enforced in `src/backend/trpc/session.trpc.ts`

## CI/CD & Deployment

**Hosting:**
- CLI Mode: Standalone Node.js server (any platform with Node.js)
- Electron Mode: Native desktop app (macOS, Windows, Linux)
- Web Mode: Browser-based frontend + backend server

**CI Pipeline:**
- No CI/CD integration detected (only local git operations)
- GitHub Actions could be integrated but not currently implemented

**Deployment:**
- CLI: Published as npm package (`factory-factory` on npm registry)
- Electron: Built with electron-builder, generates installers/dmg/appx
- Docker: Not configured

## Environment Configuration

**Required env vars:**
- `DATABASE_PATH` - SQLite database file (optional, defaults to ~/factory-factory/data.db)
- `BACKEND_PORT` - Server port (default: 4001)
- `FRONTEND_PORT` - Frontend port (default: 4000)
- `NODE_ENV` - development, production, test
- `BASE_DIR` - Base directory for worktrees and data (default: ~/factory-factory)
- `WORKTREE_BASE_DIR` - Git worktrees location (default: $BASE_DIR/worktrees)

**Model Configuration:**
- `ORCHESTRATOR_MODEL` - LLM model (sonnet, opus, haiku)
- `SUPERVISOR_MODEL` - LLM model (sonnet, opus, haiku)
- `WORKER_MODEL` - LLM model (sonnet, opus, haiku)

**Permission Modes:**
- `ORCHESTRATOR_PERMISSIONS` - strict, relaxed, yolo
- `SUPERVISOR_PERMISSIONS` - strict, relaxed, yolo
- `WORKER_PERMISSIONS` - strict, relaxed, yolo

**Secrets location:**
- No app-managed secrets
- Claude auth: System-managed via `claude login`
- Git auth: System SSH keys or git credentials
- GitHub auth: Stored in system `gh` CLI config

## Webhooks & Callbacks

**Incoming:**
- None detected. No webhook endpoints for external services.

**Outgoing:**
- PR detection via git commit messages (detects GitHub PR URLs in output)
- Workspace notifications sent via WebSocket to frontend (`src/backend/routers/websocket/chat.handler.ts`)
- No outgoing webhook calls to external services

**Internal WebSocket Channels:**
- `/chat` - Claude Code streaming protocol (bidirectional)
- `/terminal` - PTY terminal session output (server → client)
- `/dev-logs` - Development server logs (server → client)

## CORS Configuration

**Allowed Origins:**
- Configured via `CORS_ALLOWED_ORIGINS` env var (default example in .env.example):
  - `http://localhost:3000` (dev frontend)
  - `http://localhost:3001` (dev backend)
  - `http://localhost:4000` (prod frontend)
  - `http://localhost:4001` (prod backend)
- Implementation: `src/backend/middleware/middleware.ts` (corsMiddleware)

## MCP (Model Context Protocol)

**Integration:**
- MCP tools initialization: `src/backend/routers/mcp/index.ts`
- MCP router: `src/backend/routers/api/mcp.router.ts`
- Purpose: Expose filesystem, execution, and project context to Claude CLI

---

*Integration audit: 2026-02-01*
