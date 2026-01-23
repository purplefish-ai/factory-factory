# FactoryFactory

<img width="1908" height="757" alt="image" src="https://github.com/user-attachments/assets/55ed7a98-5cc3-4d87-b4a6-3c8c07242132" />


FactoryFactory is an autonomous software development orchestration system that uses AI agents to manage and execute software development tasks from Linear issues.

## Overview

FactoryFactory coordinates multiple AI agents to autonomously:
- Break down Linear epics into implementable tasks
- Create git worktrees and branches for isolated work
- Execute tasks using tmux sessions
- Create pull requests and manage code reviews
- Orchestrate complex development workflows

## Prerequisites

Before setting up FactoryFactory, ensure you have the following installed:

- **Node.js 18+** - [Download](https://nodejs.org/)
- **Docker and Docker Compose** - [Download](https://www.docker.com/products/docker-desktop)
- **GitHub CLI (`gh`)** - [Installation guide](https://cli.github.com/)
- **tmux** - Install via your package manager (e.g., `brew install tmux` on macOS)
- **Claude Code CLI** - Install and authenticate with `claude` (uses OAuth, no API key needed)

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd FactoryFactory
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values:
- `DATABASE_URL` - PostgreSQL connection string (default works with Docker setup)
- `GIT_BASE_REPO_PATH` - Path to your test repository (e.g., `~/Programming/monorepo`)
- `GIT_WORKTREE_BASE` - Directory for git worktrees (e.g., `/tmp/factoryfactory-worktrees`)
- `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` - Generate these for local dev

Note: No API key needed. FactoryFactory uses Claude Code CLI with OAuth authentication.

### 3. Start PostgreSQL

```bash
docker-compose up -d
```

### 4. Run Database Migrations

```bash
npm run db:migrate
```

### 5. Start Development Servers

In separate terminal windows:

```bash
# Terminal 1: Backend server
npm run backend:dev

# Terminal 2: Frontend (Next.js)
npm run dev

# Terminal 3: Inngest dev server
npm run inngest:dev
```

## Verify Installation

- **Frontend**: http://localhost:3000
- **Backend Health Check**: http://localhost:3001/health
- **Inngest Dashboard**: http://localhost:8288
- **Prisma Studio**: `npm run db:studio` (opens on http://localhost:5555)

## Project Structure

```
FactoryFactory/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── backend/
│   │   ├── clients/           # Git, GitHub, Tmux, Terminal clients
│   │   ├── inngest/           # Event-driven functions
│   │   │   └── functions/     # Event handlers (mail.sent, etc.)
│   │   ├── resource_accessors/# Database access layer
│   │   ├── routers/
│   │   │   └── mcp/          # MCP tool implementations
│   │   ├── testing/           # Mock agent utilities
│   │   ├── db.ts              # Prisma client
│   │   └── index.ts           # Backend server
│   └── frontend/
│       ├── app/               # Next.js App Router
│       └── components/        # React components (tmux-terminal, etc.)
├── docs/
│   └── MCP_TOOLS.md          # MCP tools documentation
├── docker-compose.yml         # PostgreSQL setup
└── package.json
```

## Database Schema

The system uses five main models:

- **Epic** - Top-level features from Linear
- **Task** - Individual work items within epics
- **Agent** - AI agents (Supervisor, Orchestrator, Worker)
- **Mail** - Inter-agent communication
- **DecisionLog** - Audit trail of agent decisions

## Development Workflow

1. **Create an epic** in the database (via Prisma Studio or API)
2. **Agents autonomously**:
   - Break down the epic into tasks
   - Assign tasks to worker agents
   - Create git worktrees and branches
   - Execute code changes
   - Create pull requests
   - Monitor and orchestrate completion

## Available Scripts

- `npm run dev` - Start Next.js frontend
- `npm run backend:dev` - Start backend server with hot reload
- `npm run inngest:dev` - Start Inngest dev server
- `npm run db:migrate` - Run Prisma migrations
- `npm run db:generate` - Generate Prisma client
- `npm run db:studio` - Open Prisma Studio GUI
- `npm run lint` - Lint code
- `npm run format` - Format code with Prettier

## Environment Variables

See `.env.example` for a complete list of environment variables with descriptions.

### Required Variables

- `DATABASE_URL` - PostgreSQL connection string
- `GIT_BASE_REPO_PATH` - Path to your repository
- `GIT_WORKTREE_BASE` - Base directory for worktrees

### Optional Variables

- `TMUX_SOCKET_PATH` - Custom tmux socket path
- `BACKEND_PORT` - Backend server port (default: 3001)
- `FRONTEND_PORT` - Frontend server port (default: 3000)
- `CLAUDE_MODEL` - Override Claude model version
- `REQUIRE_HUMAN_APPROVAL` - Require human approval for actions

## Test Repository Setup

FactoryFactory needs a Git repository to manage worktrees. By default, it expects a repository at `~/Programming/monorepo`.

To use a different repository:

1. Update `GIT_BASE_REPO_PATH` in `.env`
2. Ensure the repository is a valid git repository
3. Ensure you have write access to the repository

## Architecture

FactoryFactory uses a multi-agent architecture:

- **Supervisor Agent** - High-level orchestrator, monitors all epics
- **Orchestrator Agents** - Manage individual epics, create and assign tasks
- **Worker Agents** - Execute individual tasks in isolated environments

Agents communicate via:
- **Database** - Shared state (epics, tasks, agents)
- **Mail System** - Asynchronous messages between agents
- **Inngest Events** - Event-driven triggers and workflows

## Implementation Status

### Phase 0: Foundation & Infrastructure ✅
- ✅ PostgreSQL database with Prisma
- ✅ Resource accessors for all models
- ✅ Git, GitHub, and Tmux clients
- ✅ Basic Inngest infrastructure
- ✅ Next.js frontend shell
- ✅ Backend server with health check

### Phase 1: MCP Infrastructure & Mail System ✅
- ✅ MCP server with tool registry
- ✅ Tool permission system (by agent type)
- ✅ Mail communication tools (`mcp__mail__*`)
- ✅ Agent introspection tools (`mcp__agent__*`)
- ✅ System tools (`mcp__system__*`)
- ✅ Decision logging infrastructure
- ✅ Terminal integration for tmux viewing
- ✅ Mock agent testing utilities
- ✅ Inngest event handlers for mail

**Not yet implemented**:
- Real agent implementation with Claude SDK (Phase 2)
- Supervisor and orchestrator agents (Phase 2+)
- Frontend UI for monitoring (Phase 3+)

## MCP Tools

Phase 1 introduces the MCP (Model Context Protocol) server for agent communication and tool execution.

### Available Tools

See [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) for complete documentation.

**Mail Tools:**
- `mcp__mail__list_inbox` - List inbox messages
- `mcp__mail__read` - Read and mark mail as read
- `mcp__mail__send` - Send mail to agents or humans
- `mcp__mail__reply` - Reply to received mail

**Agent Introspection Tools:**
- `mcp__agent__get_status` - Get agent status and metadata
- `mcp__agent__get_task` - Get current task (WORKER only)
- `mcp__agent__get_epic` - Get current epic

**System Tools:**
- `mcp__system__log_decision` - Manually log decisions

### Testing MCP Tools

Run the test suite:

```bash
# Start the backend server
npm run backend:dev

# In another terminal, run tests
tsx src/backend/testing/test-scenarios.ts
```

### Example: Send Mail via MCP

```bash
curl -X POST http://localhost:3001/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent-id-here",
    "toolName": "mcp__mail__send",
    "input": {
      "toHuman": true,
      "subject": "Test Mail",
      "body": "This is a test message"
    }
  }'
```

## Troubleshooting

### PostgreSQL connection issues
- Ensure Docker is running: `docker ps`
- Check PostgreSQL logs: `docker-compose logs postgres`
- Verify connection string in `.env`

### GitHub CLI authentication
```bash
gh auth status
gh auth login
```

### Prisma issues
```bash
# Reset database (WARNING: destroys data)
npx prisma migrate reset

# Re-generate Prisma client
npm run db:generate
```

## Contributing

This is an experimental project. See the DESIGN.md and PHASE-*.md files for the complete architecture and roadmap.

## License

MIT
