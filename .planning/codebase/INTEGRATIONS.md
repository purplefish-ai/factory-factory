# External Integrations

**Analysis Date:** 2026-01-31

## APIs & External Services

**Claude Code CLI:**
- Primary integration for AI-powered coding assistance
- SDK/Client: Spawned as child process via `spawn('claude', args)` in `src/backend/claude/process.ts`
- Auth: Uses OAuth via `claude login` (no API key required)
- Protocol: JSON streaming over stdio (`--output-format stream-json`, `--input-format stream-json`)
- Features used: Session resume, permission modes, system prompts, model selection
- Process management: Full lifecycle with resource monitoring, hung process detection
- Configuration: `ORCHESTRATOR_MODEL`, `SUPERVISOR_MODEL`, `WORKER_MODEL` env vars

**GitHub CLI (gh):**
- Purpose: PR management, review workflows, repository interactions
- SDK/Client: `gh` CLI via `execFileAsync()` in `src/backend/services/github-cli.service.ts`
- Auth: Local `gh auth login` (uses existing GitHub authentication)
- Features used:
  - `gh pr view` - PR status, reviews, CI status
  - `gh pr list` - Find PRs for branches
  - `gh pr review` - Submit approvals, request changes
  - `gh pr diff` - Fetch PR diffs
  - `gh search prs` - List review requests
  - `gh api user` - Get authenticated username
- Error handling: Classifies CLI errors (not_installed, auth_required, pr_not_found, network_error)

## Data Storage

**Database:**
- SQLite via better-sqlite3 native driver
- Connection: `DATABASE_PATH` env var or computed from `BASE_DIR`
- ORM: Prisma 7.3.0 with `@prisma/adapter-better-sqlite3`
- Schema: `prisma/schema.prisma`
- Generated client: `prisma/generated/`
- Models: Project, Workspace, ClaudeSession, TerminalSession, DecisionLog, UserSettings

**File Storage:**
- Local filesystem only
- Worktrees: `WORKTREE_BASE_DIR` (default: `~/factory-factory/worktrees`)
- Session logs: `BASE_DIR/logs/`
- Debug files: `BASE_DIR/debug/`

**Caching:**
- None (all state in SQLite)

## Real-time Communication

**WebSocket Endpoints:**
- `/chat` - Claude Code CLI streaming (JSON protocol)
  - Handler: `src/backend/routers/websocket/chat.handler.ts`
  - Bidirectional message streaming with session management
- `/terminal` - PTY terminal sessions
  - Handler: `src/backend/routers/websocket/terminal.handler.ts`
  - Uses `node-pty` for pseudo-terminal multiplexing
- `/dev-logs` - Development logging stream
  - Handler: `src/backend/routers/websocket/dev-logs.handler.ts`

**WebSocket Server:**
- Implementation: `ws` library
- Features: Heartbeat detection (30s), zombie connection cleanup
- Upgrade handling in `src/backend/server.ts`

## Authentication & Identity

**Auth Provider:**
- None currently (`FEATURE_AUTHENTICATION=false` default)
- Single-user mode with `UserSettings.userId = "default"`

**External Auth Dependencies:**
- Claude CLI: OAuth via `claude login`
- GitHub CLI: `gh auth login`

## Terminal & Process Management

**PTY Terminal:**
- Library: `node-pty` 1.1.0
- Service: `src/backend/services/terminal.service.ts`
- Features: Shell detection, workspace-scoped sessions, resize support

**Process Spawning:**
- Child process management throughout:
  - Claude CLI: `src/backend/claude/process.ts`
  - Startup scripts: `src/backend/services/startup-script.service.ts`
  - Run scripts: `src/backend/services/run-script.service.ts`
  - Shell commands: `src/backend/lib/shell.ts`

**Resource Monitoring:**
- Library: `pidusage` 4.0.1
- Features: Memory limits (2GB default), CPU warnings, hung process detection
- Config: `CLAUDE_HUNG_TIMEOUT_MS` env var (default: 30 minutes)

## Monitoring & Observability

**Error Tracking:**
- Feature flag: `FEATURE_ERROR_TRACKING=false` (disabled by default)
- No external service configured

**Logging:**
- Custom logger service: `src/backend/services/logger.service.ts`
- Levels: error, warn, info, debug (via `LOG_LEVEL` env var)
- Session file logging: `src/backend/services/session-file-logger.service.ts`

**Metrics:**
- Feature flag: `FEATURE_METRICS=false` (disabled by default)
- No Prometheus/metrics endpoint configured

**Health Checks:**
- Endpoint: `/health`, `/health/all`
- Router: `src/backend/routers/api/health.router.ts`
- Interval: `HEALTH_CHECK_INTERVAL_MS` (default: 5 minutes)

## CI/CD & Deployment

**Hosting:**
- Electron desktop app (primary distribution)
- Can run as web server via CLI (`ff serve`)

**CI Pipeline:**
- Not detected in codebase (likely external)

**Build Commands:**
```bash
pnpm build           # Production build (backend + frontend)
pnpm build:electron  # Electron distribution package
```

## Environment Configuration

**Required env vars (production):**
- None strictly required (sensible defaults exist)

**Recommended env vars:**
- `DATABASE_PATH` - SQLite database location
- `BASE_DIR` - Root for all data (worktrees, logs)
- `BACKEND_PORT` - Server port (default: 4001)
- `FRONTEND_PORT` - Frontend port (default: 4000)

**Optional integrations:**
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins
- `LOG_LEVEL` - Logging verbosity (error, warn, info, debug)

**Secrets location:**
- No secrets stored in codebase
- External CLIs handle their own auth:
  - Claude: `~/.claude/` directory
  - GitHub: `~/.config/gh/` directory

## MCP (Model Context Protocol)

**MCP Server:**
- Router: `src/backend/routers/api/mcp.router.ts`
- Tools initialization: `src/backend/routers/mcp/index.ts`
- Purpose: Exposes tools to Claude via MCP protocol

## Webhooks & Callbacks

**Incoming:**
- None detected

**Outgoing:**
- None detected (GitHub interactions are pull-based via CLI)

## External Tool Dependencies

**Required CLI Tools:**
| Tool | Purpose | Verification |
|------|---------|--------------|
| `claude` | AI coding assistance | `src/backend/services/cli-health.service.ts` |
| `gh` | GitHub operations | `githubCLIService.checkHealth()` |
| `git` | Version control, worktrees | Used throughout for branch/worktree management |

**Optional CLI Tools:**
| Tool | Purpose |
|------|---------|
| `bash` | Script execution (startup/run scripts) |
| Shell (`zsh`/`bash`) | Terminal sessions |

---

*Integration audit: 2026-01-31*
