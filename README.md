<p align="center">
  <img src="public/logo-full.svg" alt="Factory Factory" width="300" height="200">
</p>

Workspace-based coding environment that lets you run multiple Claude Code sessions in parallel, each with their own isolated git worktree.

## Prerequisites

- **Node.js 18+**
- **pnpm** - Package manager
- **GitHub CLI (`gh`)** - authenticated
- **Claude Code** - authenticated via `claude login`

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Start the server
pnpm dev

# Browser opens automatically to http://localhost:3000
```

The server will automatically:
- Create the data directory (`~/factory-factory/`)
- Run database migrations
- Find available ports if defaults are in use
- Open your browser when ready

## Commands

```bash
# Development
pnpm dev              # Start dev server (hot reload, auto-migrations, browser open)
pnpm dev --no-open    # Start without opening browser
pnpm dev --verbose    # Start with detailed logging

# Production
pnpm build            # Build for production
pnpm start            # Start production server

# Testing & Quality
pnpm test             # Run tests
pnpm test:watch       # Run tests in watch mode
pnpm check:fix        # Lint + format with Biome
pnpm typecheck        # TypeScript checking

# Database
pnpm db:migrate       # Run migrations
pnpm db:studio        # Open Prisma Studio
pnpm db:generate      # Regenerate Prisma client

# Other
pnpm storybook        # Component development
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
- **File browser:** View and diff files in each workspace
- **Session persistence:** Resume previous Claude sessions

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
The server automatically finds available ports. Use `--verbose` to see which ports are being used.

## License

MIT
