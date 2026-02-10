# External Integrations

**Analysis Date:** 2026-02-10

## APIs & External Services

**GitHub Integration:**
- Service: GitHub (via GitHub CLI `gh`)
- What it's used for: Issue fetching, PR monitoring, PR metadata, CI status tracking, review comment monitoring
- SDK/Client: GitHub CLI (`gh` command-line tool, locally authenticated)
- Implementation: `src/backend/services/github-cli.service.ts`
- Authentication: Local `gh auth` (requires user to authenticate once via `gh auth login`)
- Features:
  - List issues for workspace repositories (`listIssuesForWorkspace`)
  - Check GitHub CLI installation and authentication health
  - Fetch PR metadata (number, state, draft status, review decision)
  - Retrieve CI check rollup status (CheckRun and StatusContext)
  - Fetch review comments and PR review state
  - Monitor PR changes for auto-fix (Ratchet feature)
  - Support issue-to-workspace linking

**Claude (Anthropic):**
- Service: Claude Code (via local CLI)
- What it's used for: Interactive coding sessions, agent dispatch, multi-model workflow
- SDK/Client: `tx spawn` (Claude CLI integration via subprocess)
- Implementation: `src/backend/claude/process.ts`, `src/backend/claude/session.ts`
- Authentication: Claude CLI auth (user configures via Claude CLI)
- Features:
  - Spawn Claude Code sessions (workflow: "explore", "implement", "test")
  - Model selection (default: "sonnet", configurable per session)
  - Session resumption via persistent session ID
  - Agent process management (with permission coordinator)
  - MCP tool integration for agent use
  - WebSocket communication for real-time chat/output

## Data Storage

**Databases:**
- Type/Provider: SQLite
- Location: `~/ factory-factory/data.db` (default) or `DATABASE_PATH` env var
- Client: Prisma 7.3.0 with better-sqlite3 adapter
- Adapter: @prisma/adapter-better-sqlite3 7.3.0
- Connection: File-based SQLite (synchronous via better-sqlite3)

**File Storage:**
- Local filesystem only
- Database migrations: `prisma/migrations/` (tracked in git)
- Workspace files: Git worktrees in configured base path
- Prompt templates: `prompts/` directory (copied to dist/ on build)

**Caching:**
- In-memory React Query (@tanstack/react-query) - Client-side server state caching
- Workspace metadata caching: Kanban column state computed and cached in `stateComputedAt`
- PR metadata cached in Workspace model (prState, prNumber, prCiStatus, etc.)
- No external cache service (Redis, Memcached)

## Authentication & Identity

**Auth Provider:**
- Custom: No external auth provider
- GitHub: Via local `gh` CLI (user authenticates once)
- Claude: Via Claude CLI (`tx` command, requires local setup)
- Implementation: User settings stored in Prisma (UserSettings model, single "default" user)

**Current Approach:**
- Single-user local-first design
- No remote authentication required
- Settings: User preferences and cache stored in SQLite (UserSettings table)
- Expandable: UserSettings has `userId` field for future multi-user support

## Monitoring & Observability

**Error Tracking:**
- None detected - No Sentry, Datadog, or external error monitoring
- Errors logged locally via logger service (`src/backend/services/logger.service.ts`)

**Logs:**
- Approach: Console logging (pino-based logger)
- Development: Pretty-printed logs
- Production: JSON logs (when NODE_ENV=production)
- Workspace logs: Captured in database (initOutput for startup scripts)
- WebSocket logs: Optional via WS_LOGS_ENABLED env var
- File logging: Session file logger for Claude and terminal session transcripts

**Monitoring Services:**
- Health check endpoint: `/health` router
- CLI health banner: Monitors GitHub CLI and Claude CLI availability
- Process monitoring: pidusage for CPU/memory tracking
- CI monitoring: Regular polling of GitHub PR CI status

## CI/CD & Deployment

**Hosting:**
- CLI deployment: Standalone npm package (`factory-factory` / `ff` binary)
- Electron deployment: Desktop app via electron-builder
- Distributed via GitHub releases or npm registry
- Self-hosted: User runs locally (no cloud infrastructure)

**CI Pipeline:**
- None detected in factory-factory repo itself
- External integrations monitored: GitHub PR CI status (via `gh cli`)
- CI Fixer service: Watches PR CI failures and dispatches agent sessions to fix

**Build Outputs:**
- Backend: Compiled to `dist/src/backend/` (Node.js)
- Frontend: Bundled to `dist/client/` (Vite)
- Electron: Built to `release/` directory (electron-builder)
- CLI entry point: `dist/src/cli/index.js` (executable via `ff` or `factory-factory`)

## Environment Configuration

**Required env vars:**
- `DATABASE_PATH` (optional) - SQLite database file path; defaults to `~/factory-factory/data.db`
- `BASE_DIR` (optional) - Base directory for factory-factory data; overridden by DATABASE_PATH
- `BACKEND_PORT` (optional) - Server port; defaults to 3001
- `NODE_ENV` (optional) - "development" or "production"; defaults to "development"
- `FRONTEND_STATIC_PATH` (optional) - Path to frontend build for production serving

**Development-specific:**
- `BACKEND_URL` - Dev frontend to backend proxy URL (default: http://localhost:3000)
- `VITE_DEV_SERVER_URL` - Electron dev server URL
- `WS_LOGS_ENABLED` - Enable WebSocket frame logging (set to "true")
- `SHELL` - Shell binary for terminal sessions (default: $SHELL or /bin/bash)

**Secrets location:**
- No application secrets stored by the app itself
- GitHub auth: Managed by local `gh` CLI (stored in ~/.config/gh/hosts.yml or similar)
- Claude auth: Managed by Claude CLI (stored in ~/.claude/config or similar)
- `.env` file: Used for development convenience (not committed)

## Webhooks & Callbacks

**Incoming:**
- None detected - The app polls GitHub for PR changes rather than using webhooks
- Health checks: Internal `/health` endpoint for CLI/Electron startup verification

**Outgoing:**
- None - The app reads from GitHub and Claude but does not push webhooks to external services
- Git pushes: Standard git push operations to GitHub (via git CLI)
- PR comments: Agent sessions can create PR comments via Claude's git integration

**Real-time Communication:**
- WebSocket endpoints (`/chat`, `/terminal`, `/dev-logs`) for live session streaming
- Server-to-client: Session output, terminal output, build logs
- Client-to-server: User input, terminal input

## Polling & Monitoring Services

**GitHub PR Monitoring:**
- Service: `src/backend/services/pr-snapshot.service.ts`
- Frequency: Periodic polling (check interval configurable)
- Monitors:
  - PR state (OPEN, CLOSED, MERGED, DRAFT)
  - CI status (PENDING, SUCCESS, FAILURE)
  - Review state and comments
  - Merge conflicts and CI failures

**CI Failure Monitoring:**
- Service: `src/backend/services/ci-monitor.service.ts`
- Tracks: First failure time, last notification time
- Triggers: CI Fixer agent dispatch on failure detection

**Ratchet Service (Auto-Fix):**
- Service: `src/backend/services/ratchet.service.ts`
- Purpose: Automated PR progression (CI checks → review comments → merge-ready)
- Polling: 1-minute check cadence for PR state changes
- Behavior: Creates fixer sessions to address CI failures or review comments

## Rate Limiting

**GitHub CLI:**
- Rate limit handling: `src/backend/services/rate-limit-backoff.ts`
- Strategy: Exponential backoff on 403 rate limit responses
- Detection: Checks error message for rate limit indicators
- Timeout values per operation: Defined in `GH_TIMEOUT_MS` (5s-60s depending on operation)

**Internal Rate Limiting:**
- Service: `src/backend/services/rate-limiter.service.ts`
- Protects: tRPC endpoints and critical operations
- Strategy: In-memory rate limit tracking

---

*Integration audit: 2026-02-10*
