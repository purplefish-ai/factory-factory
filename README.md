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

# 2. Start the server (migrations run automatically)
pnpm cli serve --dev

# Browser opens automatically to http://localhost:3000
```

That's it! The CLI will:
- Create the data directory (`~/factory-factory/`)
- Run database migrations automatically
- Start backend and frontend servers
- Open your browser when ready

## CLI Usage

The `ff` (or `factory-factory`) command provides a unified interface for running FactoryFactory:

```bash
# Start in development mode (with hot reloading)
pnpm cli serve --dev

# Start in production mode (requires build first)
pnpm cli build
pnpm cli serve

# Start without opening browser
pnpm cli serve --dev --no-open

# Use custom ports
pnpm cli serve --dev --port 4000 --backend-port 4001

# Enable verbose logging
pnpm cli serve --dev --verbose

# Run database migrations manually
pnpm cli db:migrate

# Open Prisma Studio for database management
pnpm cli db:studio
```

### CLI Options

```
Usage: ff serve [options]

Options:
  -p, --port <port>           Frontend port (default: "3000")
  --backend-port <port>       Backend port (default: "3001")
  -d, --database-path <path>  SQLite database file path (default: ~/factory-factory/data.db)
  --host <host>               Host to bind to (default: "localhost")
  --dev                       Run in development mode with hot reloading
  --no-open                   Do not open browser automatically
  -v, --verbose               Enable verbose logging
```

### Port Detection

If the default ports (3000/3001) are in use, the CLI will automatically find the next available ports.

## Verify Installation

- Frontend: http://localhost:3000
- Backend: http://localhost:3001/health
- Prisma Studio: `pnpm cli db:studio`

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

## Development

```bash
pnpm dev:all       # Start frontend + backend (alternative to CLI)
pnpm typecheck     # TypeScript checking
pnpm check:fix     # Lint + format with Biome
pnpm test          # Run tests
pnpm storybook     # Component development
```

## Troubleshooting

**GitHub CLI:**
```bash
gh auth status
gh auth login
```

**Database issues:**
```bash
pnpm cli db:migrate              # Run migrations
pnpm exec prisma migrate reset   # Reset database (destroys data)
pnpm db:generate                 # Regenerate Prisma client
```

**Port conflicts:**
The CLI automatically finds available ports. Use `--verbose` to see which ports are being used.

## Production

```bash
# Build for production
pnpm cli build

# Start production server
pnpm cli serve
```

## License

MIT
