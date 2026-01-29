# External Integrations

**Analysis Date:** 2026-01-29

## APIs & External Services

**GitHub (via GitHub CLI):**
- Service: GitHub repository and pull request management
  - SDK/Client: `gh` CLI (spawned as subprocess, not npm package)
  - Implementation: `src/backend/services/github-cli.service.ts` (624 lines)
  - Auth: GitHub CLI authentication (`gh auth login` required)
- Use cases:
  - Fetch PR details, status, review state
  - List PRs where user is requested as reviewer
  - Detect PR creation from workspace branches
  - CI status checks via GitHub GraphQL API (via `gh` CLI)

**Claude AI (via Claude CLI):**
- Service: AI-powered chat and code analysis
  - SDK/Client: `claude` CLI (spawned as child process)
  - Implementation: `src/backend/claude/process.ts`, `src/backend/claude/session.ts`, `src/backend/claude/protocol.ts`
  - Auth: OAuth via `claude login` (credentials stored in `~/.claude/auth/`)
- Use cases:
  - Chat sessions with Claude Code CLI
  - Code exploration and analysis
  - Guided implementation workflows
  - PR review suggestions
  - Decision logging via Claude integration
- Models supported:
  - claude-sonnet-4-5-20250929 (default)
  - claude-opus-4-5-20251101
  - claude-3-5-haiku-20241022
- Features:
  - Session resumption (via `--resume-session-id`)
  - Extended thinking (enabled via `--thinking`)
  - Streaming JSON protocol for real-time communication
  - Permission modes: strict, relaxed, yolo
  - Resource monitoring (CPU, memory, activity timeouts)

## Data Storage

**Databases:**
- SQLite (embedded)
  - Type: SQLite 3
  - Location: Configurable via `DATABASE_PATH` env var
    - Default web/CLI: `~/factory-factory/data.db`
    - Electron macOS: `~/Library/Application Support/Factory Factory/data.db`
    - Electron Windows: `%APPDATA%/Factory Factory/data.db`
    - Electron Linux: `~/.config/Factory Factory/data.db`
  - Client: `better-sqlite3` (native binding)
  - ORM: Prisma 7.3.0 with `@prisma/adapter-better-sqlite3`
  - Schema: `prisma/schema.prisma`
  - Tables: Project, Workspace, ClaudeSession, TerminalSession, DecisionLog

**File Storage:**
- Local filesystem only
  - Worktrees: `BASE_DIR/worktrees/` (git worktree directories)
  - Database: Configurable location (default `BASE_DIR/data.db`)
  - Logs: `BASE_DIR/logs/` (debug and runtime logs)
  - Migrations: `prisma/migrations/` (Prisma migration history)

**Caching:**
- None detected (no Redis, Memcached, or in-process cache dependency)

## Authentication & Identity

**Auth Provider:**
- Custom (no third-party OAuth service)

**Implementation:**
- GitHub CLI (`gh auth login`) - Requires manual authentication
  - Credentials stored in `~/.config/gh/` (GitHub CLI home)
  - Checked via `gh auth status` in `github-cli.service.ts`

- Claude CLI (`claude login`) - OAuth via Anthropic
  - Credentials stored in `~/.claude/auth/`
  - No API key needed (uses OAuth token)

- No user authentication for FactoryFactory UI itself (feature flag `FEATURE_AUTHENTICATION` disabled by default)

## Monitoring & Observability

**Error Tracking:**
- Not detected in dependencies
- Feature flag `FEATURE_ERROR_TRACKING` disabled by default
- Could be added via environment configuration

**Logs:**
- Winston logger (`src/backend/services/logger.service.ts`)
  - Pretty print in development, JSON in production
  - Configurable via `LOG_LEVEL` env var (error, warn, info, debug)
  - Service name: `SERVICE_NAME` env var

**Health Checks:**
- Health check service (`src/backend/services/health-check.service.ts`)
  - Interval: `HEALTH_CHECK_INTERVAL_MS` (default 5 minutes)
  - Agent heartbeat threshold: `AGENT_HEARTBEAT_THRESHOLD_MINUTES` (default 7)
  - Crash recovery monitoring with max attempts (`MAX_WORKER_ATTEMPTS`)

**Monitoring:**
- Resource monitoring for Claude processes:
  - CPU usage tracking (via `pidusage`)
  - Memory usage with limits (default 2GB)
  - Activity timeout detection (default 30 minutes)
  - Process hung detection

## CI/CD & Deployment

**Hosting:**
- None configured for the application itself
- GitHub repository for source code
- Electron desktop app (self-hosted distribution)

**CI Pipeline:**
- GitHub Actions workflows (in `.github/workflows/`, content not analyzed)

**Building:**
- `pnpm build` - Compiles TypeScript, builds frontend with Vite, generates Electron bundle
- `pnpm build:electron` - Builds distributable Electron packages (`.dmg`, `.exe`, `.deb`, `.AppImage`)

**Deployment:**
- Desktop app: Manual or auto-update via Electron's update mechanism (not configured)
- CLI tool: npm/pnpm package (entries in `bin` field)
  - `ff` or `factory-factory` commands

## Environment Configuration

**Required env vars:**
- `DATABASE_PATH` - Optional (falls back to default)
- `BACKEND_PORT` - Optional (default 3001)
- `FRONTEND_PORT` - Optional (default 4000)
- `NODE_ENV` - Optional (default development)
- `BASE_DIR` - Optional (defaults to `~/factory-factory`)

**Authentication env vars:**
- No `ANTHROPIC_API_KEY` needed (uses OAuth via Claude CLI)

**Feature flags:**
- `FEATURE_AUTHENTICATION` - Enable/disable app-level auth (default false)
- `FEATURE_METRICS` - Enable Prometheus metrics (default false)
- `FEATURE_ERROR_TRACKING` - Enable error tracking (default false)

**Secrets location:**
- GitHub: `~/.config/gh/` (gh CLI authentication)
- Claude: `~/.claude/auth/` (Claude CLI OAuth)
- Database: `DATABASE_PATH` location (SQLite file)
- No secrets in `.env` file (OAuth-based, not token-based)

## Webhooks & Callbacks

**Incoming:**
- `/chat` WebSocket - Claude Code CLI streaming protocol (JSON messages)
- `/terminal` WebSocket - PTY terminal session output

**Outgoing:**
- Git operations (via child process, no network webhooks)
- GitHub CLI calls (via subprocess, results polled)
- Claude CLI calls (via subprocess, streaming JSON protocol)

## Real-time Communication

**WebSocket Endpoints:**
- `ws://localhost:{BACKEND_PORT}/chat` - Claude session messages
  - Used for streaming Claude responses from CLI
  - Protocol: Custom JSON format (`src/backend/claude/protocol.ts`)

- `ws://localhost:{BACKEND_PORT}/terminal` - PTY terminal output
  - Used for terminal session streaming
  - Real-time terminal data from `node-pty`

**HTTP Endpoints:**
- `/api/trpc/*` - tRPC RPC procedures
  - Routers: `project.trpc.ts`, `workspace.trpc.ts`, `session.trpc.ts`, `admin.trpc.ts`, `pr-review.trpc.ts`

---

*Integration audit: 2026-01-29*
