# FactoryFactory

Autonomous software development orchestration system that uses AI agents to execute tasks from Linear issues.

## Prerequisites

- **Node.js 18+**
- **Docker** (for PostgreSQL)
- **GitHub CLI (`gh`)** - authenticated
- **tmux**
- **Claude Code** - authenticated via `claude login`

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env: set GIT_BASE_REPO_PATH, GIT_WORKTREE_BASE

# 3. Start PostgreSQL
docker-compose up -d

# 4. Run migrations
npm run db:migrate

# 5. Start all servers
npm run dev:all
```

## Verify Installation

- Frontend: http://localhost:3000
- Backend: http://localhost:3001/health
- Inngest: http://localhost:8288
- Prisma Studio: `npm run db:studio`

## Architecture

Three-tier agent hierarchy:

```
Orchestrator (1 per system) - system health, supervisor lifecycle
    └── Supervisor (1 per Epic) - breaks down epic, reviews/merges PRs
            └── Worker (1 per Task) - implements in isolated git worktree
```

Agents communicate via:
- **Mail System** - async messages between agents
- **Inngest Events** - triggers workflows (`epic.created` → supervisor, `task.created` → worker)
- **Database** - shared state

PRs are merged sequentially to avoid complex conflicts. Workers rebase when requested.

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
npx prisma migrate reset    # Reset database (destroys data)
npm run db:generate         # Regenerate client
```

## Documentation

- [User Guide](docs/USER_GUIDE.md)
- [Deployment Guide](docs/DEPLOYMENT_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [MCP Tools](docs/MCP_TOOLS.md)

## Production

```bash
docker-compose --profile production up -d
```

See [Deployment Guide](docs/DEPLOYMENT_GUIDE.md) for details.

## License

MIT
