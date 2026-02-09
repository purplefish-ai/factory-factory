# External Integrations

**Analysis Date:** 2026-02-09

## APIs & External Services

**Claude AI:**
- Claude Code CLI - Invoked as subprocess for AI code generation and assistance
  - SDK/Client: Custom ClaudeClient in `src/backend/claude/index.ts`
  - Protocol: Streaming JSON protocol over stdout/stdin
  - Auth: OAuth via local `claude login` (no API key needed)
  - Configuration: Model selection via `DEFAULT_MODEL` env var (sonnet, opus, haiku)
  - Permission modes: Auto-approve, mode-based (strict/relaxed/yolo), or interactive

## Data Storage

**Databases:**
- SQLite 3
  - Connection: `sqlite://DATABASE_PATH` (default: `~/factory-factory/data.db`)
  - Client: Prisma ORM v7.3.0
  - Adapter: better-sqlite3 v12.6.2 (synchronous driver)
  - Schema: `src/backend/prisma/schema.prisma`
  - Migrations: `prisma/migrations/` (managed by Prisma)

**File Storage:**
- Local filesystem only
  - Database: SQLite file at `DATABASE_PATH`
  - Worktrees: Managed at `WORKTREE_BASE_DIR` (default: `~/factory-factory/worktrees`)
  - Logs: Written to `BASE_DIR/logs` (default: `~/factory-factory/logs`)
  - Prompts: Embedded in dist at `prompts/` (copied during build)

**Caching:**
- React Query (@tanstack/react-query) - Client-side cache for tRPC queries
- No external cache service

## Authentication & Identity

**Auth Provider:**
- Custom (OAuth via Claude CLI)
  - Implementation: `src/backend/claude/index.ts` manages Claude session authentication
  - Local auth check: `gh cli` installed and authenticated for GitHub integration
  - No user authentication system (single-user desktop app)
  - Permission system: Mode-based (strict/relaxed/yolo) for tool execution

**GitHub Integration:**
- gh CLI (GitHub Command Line)
  - Health check: `src/backend/services/github-cli.service.ts` verifies installation and auth
  - Functions: Issue listing, PR status checks, review comment fetching, CI status
  - Environment: Relies on `gh auth login` (user must authenticate once)
  - Timeout: 30s default, 10s for user/review lookups, 60s for diff retrieval
  - Required env vars: None hardcoded; project configs `githubOwner` and `githubRepo` in database

## Monitoring & Observability

**Error Tracking:**
- Feature flag: `FEATURE_ERROR_TRACKING` (default: false)
- Not implemented by default

**Logs:**
- Approach: Custom logger service via pino library
  - Location: `src/backend/services/logger.service.ts`
  - Output: Console (dev) and file (prod)
  - File logs: `BASE_DIR/logs/` directory
  - WebSocket session logs: Optional via `WS_LOGS_ENABLED` env var
  - Log levels: error, warn, info, debug (configurable via `LOG_LEVEL`)
- Claude session events: Stored in session store and appended to database

**Metrics:**
- Feature flag: `FEATURE_METRICS` (default: false)
- Not implemented by default

## CI/CD & Deployment

**Hosting:**
- Desktop: Electron app (cross-platform: macOS, Linux, Windows)
- CLI: Node.js standalone (requires system git and optional gh CLI)
- Web: Optional static frontend serving via Express (default none)

**CI Pipeline:**
- Not configured at repo level
- Monitors external CI systems:
  - GitHub PR status checks via `gh pr checks` (async monitoring)
  - PR state transitions (draft, open, merged, closed)
  - Ratchet state machine tracks CI failures and initiates auto-fix sessions

## Environment Configuration

**Required env vars:**
- `DATABASE_PATH` - SQLite database file location (default: `~/factory-factory/data.db`)
- `BACKEND_PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment mode (development/production)

**Optional but important:**
- `DEFAULT_MODEL` - Claude model to use (sonnet/opus/haiku, default: sonnet)
- `DEFAULT_PERMISSIONS` - Permission mode (strict/relaxed/yolo, default: yolo)
- `CLAUDE_RATE_LIMIT_PER_MINUTE` - API rate limit (default: 60)
- `CLAUDE_RATE_LIMIT_PER_HOUR` - API rate limit (default: 1000)
- `LOG_LEVEL` - Logging verbosity (error/warn/info/debug)
- `CORS_ALLOWED_ORIGINS` - Comma-separated allowed origins

**Secrets location:**
- No secrets file (.env not committed)
- GitHub token: Uses local `gh` CLI auth (stored in user's home directory by GitHub CLI)
- Claude auth: OAuth via `claude login` (stored locally by Claude CLI)

## Webhooks & Callbacks

**Incoming:**
- None - Server does not expose webhook endpoints

**Outgoing:**
- Git push events: Workspace worktrees are committed and pushed to GitHub (triggered by Claude or user)
- PR creation/updates: Initiated by Claude sessions, tracked via `gh` CLI
- Branch operations: Auto-generated or user-specified via workspace creation

## Project & GitHub Integration

**Repository Linking:**
- Projects can be linked to GitHub repos via `githubOwner` and `githubRepo` fields
- Workspaces created from GitHub issues track `githubIssueNumber`, `githubIssueUrl`, `prUrl`
- Creation source tracking: MANUAL, RESUME_BRANCH, or GITHUB_ISSUE

**PR Tracking (Ratchet Feature):**
- Workspace can track associated pull requests
- Fields: `prNumber`, `prState`, `prCiStatus`, `prUrl`
- PR state enum: NONE, DRAFT, OPEN, CHANGES_REQUESTED, APPROVED, MERGED, CLOSED
- CI status enum: UNKNOWN, PENDING, SUCCESS, FAILURE
- Auto-fix workflow: Monitors PR state and auto-dispatches fixer sessions on CI failure or review comments

**Async Polling:**
- Ratchet service checks workspace PR state every ~1 minute
- PR monitor service fetches latest CI status and review comments
- Fixer sessions created automatically when ratchet detects actionable failures

---

*Integration audit: 2026-02-09*
