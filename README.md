<p align="center">
  <img src="public/logo-full.svg" alt="Factory Factory" width="400">
</p>

<p align="center">
  <strong>Workspace-based coding environment for running multiple Claude Code sessions in parallel.</strong>
</p>

<p align="center">
  Each workspace gets its own isolated git worktree, enabling true parallel development.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/factory-factory"><img src="https://img.shields.io/npm/v/factory-factory" alt="npm"></a>
  <a href="https://github.com/purplefish-ai/factory-factory/actions/workflows/ci.yml"><img src="https://github.com/purplefish-ai/factory-factory/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/purplefish-ai/factory-factory/blob/main/LICENSE"><img src="https://img.shields.io/github/license/purplefish-ai/factory-factory" alt="License"></a>
</p>

<p align="center">
  <img src="public/working.png" alt="Factory Factory Screenshot" width="800">
</p>

---

## Installation

**Prerequisites:**
- Node.js 18+
- pnpm
- GitHub CLI (`gh`) - authenticated
- Claude Code - authenticated via `claude login`

```bash
# Clone and install
git clone https://github.com/purplefish-ai/factory-factory.git
cd factory-factory
pnpm install

# Option A: Install CLI globally from source
pnpm link --global

# Option B: Install from npm (when published)
npm install -g factory-factory
```

## Running

### Web App

```bash
# Using pnpm (recommended for development)
pnpm dev

# Or using the CLI directly (if installed globally)
ff serve --dev
```

The server automatically:
- Creates the data directory (`~/.factory-factory/`)
- Migrates data from old `~/factory-factory/` if it exists
- Runs database migrations
- Finds available ports if defaults are in use
- Opens your browser when ready

### Desktop App (Electron)

```bash
# Development with hot reload
pnpm dev:electron

# Build distributable
pnpm build:electron
```

The Electron app stores data in the standard location for your OS:
- **macOS:** `~/Library/Application Support/Factory Factory/`
- **Windows:** `%APPDATA%/Factory Factory/`
- **Linux:** `~/.config/Factory Factory/`

## CLI Reference

```
Usage: ff serve [options]

Options:
  -p, --port <port>           Frontend port (default: 3000)
  --backend-port <port>       Backend port (default: 3001)
  -d, --database-path <path>  SQLite database path (default: ~/.factory-factory/data.db)
  --host <host>               Host to bind to (default: localhost)
  --dev                       Development mode with hot reloading
  --no-open                   Don't open browser automatically
  -v, --verbose               Enable verbose logging
```

**Other CLI commands:**
```bash
ff build        # Build for production
ff db:migrate   # Run database migrations
ff db:studio    # Open Prisma Studio
```

## Development Commands

```bash
# Server
pnpm dev              # Start dev server
pnpm dev -- --no-open    # Without browser auto-open
pnpm dev -- --verbose    # With detailed logging
pnpm build            # Build for production
pnpm start            # Start production server

# Electron
pnpm dev:electron     # Start Electron with hot reload
pnpm build:electron   # Build distributable package

# Quality
pnpm test             # Run tests
pnpm typecheck        # TypeScript checking
pnpm check:fix        # Lint + format

# Database
pnpm db:migrate       # Run migrations
pnpm db:studio        # Prisma Studio
pnpm db:generate      # Regenerate Prisma client
```

## Architecture

```
Project (repository configuration)
    └── Workspace (isolated git worktree)
            ├── ClaudeSession (chat with Claude Code)
            └── TerminalSession (PTY terminal)
```

**Key features:**
- **Isolated workspaces:** Each workspace gets its own git worktree and branch
- **Real-time chat:** WebSocket-based streaming from Claude Code CLI
- **Terminal access:** Full PTY terminals per workspace
- **Session persistence:** Resume previous Claude sessions

## Feature Highlights

### Ratchet (automatic PR progression)

Ratchet is a background monitor that continuously moves open PR workspaces toward merge.

- Runs every minute against READY workspaces with PRs
- Pulls fresh PR state from GitHub (`gh`) and classifies it into: `CI_RUNNING`, `CI_FAILED`, `MERGE_CONFLICT`, `REVIEW_PENDING`, `READY`, or `MERGED`
- Triggers (or reuses) a dedicated **ratchet** Claude session to fix CI failures, resolve merge conflicts, or address requested review changes
- Prevents duplicate fixer sessions per workspace and can notify an active fixer if a priority state changes
- Configurable in **Admin → Ratchet** with toggles for CI fixes, conflict fixes, review fixes, allowed reviewers, and auto-merge behavior

### GitHub integration (issues + PR state)

Factory Factory integrates with GitHub through the local authenticated `gh` CLI.

- Project-level GitHub linkage (`githubOwner` + `githubRepo`) enables issue/PR workflows
- Workspace session start supports **Import from GitHub Issues** (picker with filtering/search)
- Selected issues are converted into an initial prompt and auto-sent when the session is ready
- Kanban’s **GitHub Issues** column pulls issues assigned to `@me`
- One-click **Start** on an issue card creates a linked workspace (`githubIssueNumber`/`githubIssueUrl`) and opens it

### Kanban view (status + intake)

The board is a real-time operational view of work and intake.

- UI columns: **GitHub Issues**, **Working**, **Waiting**, **Done**
- Workspace column derivation is automatic:
  - `WORKING`: provisioning/new/failed, or actively running
  - `WAITING`: idle workspaces that have had at least one session
  - `DONE`: merged PRs
- READY workspaces with no prior sessions are hidden from the board
- Issue cards are filtered to avoid duplicates once an issue is already linked to a workspace
- Refresh syncs PR state and re-fetches board + issues

### Quick Actions

Quick actions provide one-click prompts for common flows.

- Workspace header quick actions are loaded from `prompts/quick-actions/*.md` (frontmatter + prompt body)
- Executing an agent quick action creates a follow-up session and auto-sends the predefined prompt
- Current built-ins include flows like review, simplify, fetch/rebase, and branch rename

## Security Considerations

> **Warning:** Factory Factory runs Claude Code in **bypass permissions mode** by default. This means Claude can execute bash commands, write and modify files, and perform other operations without asking for confirmation.

This design choice enables uninterrupted parallel workflows, but you should be aware that:
- Claude has full access to your filesystem within each workspace
- Commands are executed automatically without manual approval
- The isolation is at the git worktree level, not the system level

**Recommendations:**
- Only use Factory Factory with repositories you trust
- Review Claude's changes before merging branches
- Consider running in a containerized environment for sensitive projects

## Brand

| Color | Hex | Usage |
|-------|-----|-------|
| Factory Yellow | `#FFE500` | Primary accent |
| White | `#FAFAFA` | Light backgrounds |
| Black | `#0A0A0A` | Dark backgrounds |

**Typography:**
- **Inter Black** - Headlines and logotype
- **IBM Plex Mono SemiBold** - Code and app icon

## Troubleshooting

**GitHub CLI:**
```bash
gh auth status
gh auth login
```

**Database issues:**
```bash
pnpm db:migrate                  # Run migrations
pnpm exec prisma migrate reset   # Reset database (destroys data)
```

**Port conflicts:**
The server automatically finds available ports. Use `--verbose` to see which ports are used.

## Acknowledgements

This project was inspired by:

- [Conductor](https://conductor.build) - Mac app for running coding agents in parallel
- [VibeKanban](https://vibekanban.com) - Visual kanban for AI-assisted development
- [Gastown](https://github.com/steveyegge/gastown) - Steve Yegge's multi-agent coding environment
- [Multiclaude](https://github.com/dlorenc/multiclaude) - Dan Lorenc's parallel Claude sessions tool

## License

MIT
