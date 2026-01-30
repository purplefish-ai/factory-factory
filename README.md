<p align="center">
  <img src="public/logo-full.svg" alt="Factory Factory" width="400">
</p>

<p align="center">
  <strong>Workspace-based coding environment for running multiple Claude Code sessions in parallel.</strong>
</p>

<p align="center">
  Each workspace gets its own isolated git worktree, enabling true parallel development.
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
git clone <repo-url>
cd factory-factory
pnpm install

# Optional: Install CLI globally
pnpm link --global
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
- Creates the data directory (`~/factory-factory/`)
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
  -d, --database-path <path>  SQLite database path (default: ~/factory-factory/data.db)
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
pnpm dev --no-open    # Without browser auto-open
pnpm dev --verbose    # With detailed logging
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
