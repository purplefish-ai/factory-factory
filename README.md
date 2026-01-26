<p align="center">
  <img src="public/logo-full.svg" alt="Factory Factory" width="300" height="200">
</p>

Workspace-based coding environment that lets you run multiple Claude Code sessions in parallel, each with their own isolated git worktree.

## Prerequisites

- **Node.js 18+**
- **pnpm** - Package manager
- **Docker** (for PostgreSQL)
- **GitHub CLI (`gh`)** - authenticated
- **Claude Code** - authenticated via `claude login`

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure
cp .env.example .env
# Edit .env: set DATABASE_URL (default works with docker-compose)

# 3. Start PostgreSQL
docker-compose up -d

# 4. Run migrations
pnpm db:migrate

# 5. Start all servers
pnpm dev:all

# 6. Create a project
# Open http://localhost:3000/projects/new
# Enter your repository path and worktree base path
```

## Verify Installation

- Frontend: http://localhost:3000
- Backend: http://localhost:3001/health
- Inngest: http://localhost:8288
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
pnpm dev:all       # Start frontend + backend + Inngest
pnpm typecheck     # TypeScript checking
pnpm check:fix     # Lint + format with Biome
pnpm test          # Run tests
pnpm storybook     # Component development
```

## Troubleshooting

**PostgreSQL connection:**
```bash
docker ps                        # Ensure Docker is running
docker-compose logs postgres     # Check logs
```

**GitHub CLI:**
```bash
gh auth status
gh auth login
```

**Prisma issues:**
```bash
pnpm exec prisma migrate reset    # Reset database (destroys data)
pnpm db:generate                  # Regenerate client
```

## Production

```bash
pnpm build:all
pnpm start:all
```

See [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) for production deployment details.

## License

MIT
