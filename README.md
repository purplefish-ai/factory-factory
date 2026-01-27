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
pnpm dev:cli

# Browser opens automatically to http://localhost:3000
```

That's it! The server will:
- Create the data directory (`~/factory-factory/`)
- Run database migrations automatically
- Start backend and frontend servers
- Open your browser when ready

## Running the Server

### Development

```bash
# Start with hot reloading (recommended for development)
pnpm dev:cli

# Start without opening browser
pnpm dev:cli --no-open

# Use custom ports
pnpm dev:cli --port 4000 --backend-port 4001

# Enable verbose logging
pnpm dev:cli --verbose
```

### Production

```bash
# Build first
pnpm build:all

# Start production server
pnpm start:cli
```

### Options

```
Options:
  -p, --port <port>           Frontend port (default: "3000")
  --backend-port <port>       Backend port (default: "3001")
  -d, --database-path <path>  SQLite database file path (default: ~/factory-factory/data.db)
  --host <host>               Host to bind to (default: "localhost")
  --no-open                   Do not open browser automatically
  -v, --verbose               Enable verbose logging
```

### Port Detection

If the default ports (3000/3001) are in use, the server will automatically find the next available ports.

## Database Commands

```bash
# Run migrations manually
pnpm db:migrate

# Open Prisma Studio for database management
pnpm db:studio

# Reset database (destroys data)
pnpm exec prisma migrate reset

# Regenerate Prisma client
pnpm db:generate
```

## Verify Installation

- Frontend: http://localhost:3000
- Backend: http://localhost:3001/health
- Prisma Studio: `pnpm db:studio`

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
pnpm dev:all       # Alternative: start frontend + backend separately
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

**Port conflicts:**
The server automatically finds available ports. Use `--verbose` to see which ports are being used.

## License

MIT
