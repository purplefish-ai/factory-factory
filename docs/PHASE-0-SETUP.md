# Phase 0 Setup Guide

This guide provides detailed step-by-step instructions for setting up the FactoryFactory Phase 0 infrastructure.

## Table of Contents

1. [Prerequisites Verification](#prerequisites-verification)
2. [Initial Setup](#initial-setup)
3. [Database Setup](#database-setup)
4. [Environment Configuration](#environment-configuration)
5. [Starting Services](#starting-services)
6. [Verification Tests](#verification-tests)
7. [Troubleshooting](#troubleshooting)

## Prerequisites Verification

Before starting, verify all prerequisites are installed:

### Node.js

```bash
node --version  # Should be 18.0.0 or higher
npm --version
```

If not installed, download from https://nodejs.org/

### Docker and Docker Compose

```bash
docker --version
docker-compose --version
```

If not installed, download from https://www.docker.com/products/docker-desktop

### GitHub CLI

```bash
gh --version
```

If not installed:
- macOS: `brew install gh`
- Linux: See https://github.com/cli/cli#installation
- Windows: Download from https://cli.github.com/

Authenticate GitHub CLI:

```bash
gh auth login
```

Follow the prompts to authenticate.

### tmux

```bash
tmux -V
```

If not installed:
- macOS: `brew install tmux`
- Linux: `sudo apt-get install tmux` or `sudo yum install tmux`

### Anthropic API Key

Get your API key from https://console.anthropic.com/

## Initial Setup

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd FactoryFactory
npm install
```

This will install all Node.js dependencies including:
- Next.js and React
- Prisma and PostgreSQL client
- Inngest SDK
- TypeScript and build tools

### 2. Verify Installation

```bash
npm list --depth=0
```

You should see all packages from package.json listed without errors.

## Database Setup

### 1. Configure PostgreSQL

The `docker-compose.yml` file is already configured with PostgreSQL 15. You can customize the credentials by setting environment variables before starting Docker.

### 2. Start PostgreSQL

```bash
docker-compose up -d
```

This will:
- Download the PostgreSQL 15 Alpine image (if not already downloaded)
- Create a container named `factoryfactory-db`
- Start PostgreSQL on port 5432
- Create a persistent volume for data

### 3. Verify PostgreSQL is Running

```bash
docker ps
```

You should see `factoryfactory-db` in the list of running containers.

Check PostgreSQL logs:

```bash
docker-compose logs postgres
```

Look for "database system is ready to accept connections".

### 4. Test PostgreSQL Connection

Using psql (if installed):

```bash
psql postgresql://factoryfactory:factoryfactory_dev@localhost:5432/factoryfactory
```

Or use a GUI client like:
- pgAdmin
- DBeaver
- TablePlus

Connection details:
- Host: localhost
- Port: 5432
- Database: factoryfactory
- Username: factoryfactory
- Password: factoryfactory_dev

### 5. Run Prisma Migrations

```bash
npm run db:migrate
```

This will:
- Create the initial migration
- Apply the migration to the database
- Generate the Prisma Client

You should see output confirming the migration was applied.

### 6. Verify Database Schema

Open Prisma Studio:

```bash
npm run db:studio
```

This opens a GUI at http://localhost:5555 where you can:
- View all tables (Epic, Task, Agent, Mail, DecisionLog)
- Manually create, read, update, and delete records
- Verify the schema matches the Prisma schema file

## Environment Configuration

### 1. Create .env File

```bash
cp .env.example .env
```

### 2. Configure Required Variables

Edit `.env` and set these required variables:

#### Database URL
Already configured for local Docker setup:
```env
DATABASE_URL="postgresql://factoryfactory:factoryfactory_dev@localhost:5432/factoryfactory?schema=public"
```

#### Claude Authentication
No API key needed - uses OAuth. Run `claude login` to authenticate.

#### Git Repository Paths

Set the path to a test repository:
```env
GIT_BASE_REPO_PATH=/Users/yourusername/Programming/monorepo
GIT_WORKTREE_BASE=/tmp/factoryfactory-worktrees
```

**Important**:
- `GIT_BASE_REPO_PATH` must point to an existing git repository
- `GIT_WORKTREE_BASE` will be created automatically

#### Inngest Keys

For local development, you can use any values:
```env
INNGEST_EVENT_KEY=local-dev-event-key
INNGEST_SIGNING_KEY=local-dev-signing-key
```

### 3. Optional Variables

You can customize:
```env
BACKEND_PORT=3001
FRONTEND_PORT=3000
TMUX_SOCKET_PATH=/tmp/factoryfactory-tmux
```

## Starting Services

FactoryFactory consists of three main services that run independently:

### 1. Backend Server

In terminal 1:
```bash
npm run backend:dev
```

Expected output:
```
Backend server running on http://localhost:3001
Health check: http://localhost:3001/health
Inngest endpoint: http://localhost:3001/api/inngest
```

Test the health check:
```bash
curl http://localhost:3001/health
```

Should return:
```json
{
  "status": "ok",
  "timestamp": "2024-01-...",
  "service": "factoryfactory-backend"
}
```

### 2. Frontend (Next.js)

In terminal 2:
```bash
npm run dev
```

Expected output:
```
- ready started server on 0.0.0.0:3000
- Local: http://localhost:3000
```

Visit http://localhost:3000 - you should see the FactoryFactory homepage.

### 3. Inngest Dev Server

In terminal 3:
```bash
npm run inngest:dev
```

Expected output:
```
Inngest dev server running on http://localhost:8288
```

Visit http://localhost:8288 - you should see the Inngest dashboard.

## Verification Tests

Run these manual tests to verify Phase 0 is working correctly:

### ✅ Test 1: PostgreSQL Connection

```bash
docker-compose exec postgres psql -U factoryfactory -d factoryfactory -c "\dt"
```

Should list all tables (Epic, Task, Agent, Mail, DecisionLog).

### ✅ Test 2: Prisma Client

Create a test script `test-prisma.ts`:

```typescript
import { prisma } from './src/backend/db';
import { TaskState } from '@prisma/client';

async function test() {
  // First create a project
  const project = await prisma.project.create({
    data: {
      name: 'Test Project',
      slug: 'test-project',
      repoPath: '/tmp/test-repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });

  // Create a top-level task (parentId = null)
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Test Top-Level Task',
      state: TaskState.PLANNING,
    },
  });

  console.log('Created task:', task);

  await prisma.task.delete({ where: { id: task.id } });
  await prisma.project.delete({ where: { id: project.id } });
  console.log('Test passed!');
}

test();
```

Run:
```bash
npx tsx test-prisma.ts
```

### ✅ Test 3: Git Client

Create a test script `test-git.ts`:

```typescript
import { gitClient } from './src/backend/clients/git.client';

async function test() {
  const worktree = await gitClient.createWorktree('test-worktree');
  console.log('Created worktree:', worktree);

  const exists = await gitClient.checkWorktreeExists('test-worktree');
  console.log('Worktree exists:', exists);

  await gitClient.deleteWorktree('test-worktree');
  console.log('Test passed!');
}

test();
```

Run:
```bash
npx tsx test-git.ts
```

### ✅ Test 4: GitHub CLI

```bash
gh auth status
```

Should show you're logged in.

Create a test issue (optional):
```bash
gh issue list --repo <your-test-repo>
```

### ✅ Test 5: Tmux Client

Create a test script `test-tmux.ts`:

```typescript
import { tmuxClient } from './src/backend/clients/tmux.client';

async function test() {
  await tmuxClient.createSession('test-session');
  console.log('Created session');

  const exists = await tmuxClient.sessionExists('test-session');
  console.log('Session exists:', exists);

  await tmuxClient.killSession('test-session');
  console.log('Test passed!');
}

test();
```

Run:
```bash
npx tsx test-tmux.ts
```

### ✅ Test 6: Resource Accessors

Create a test script `test-accessors.ts`:

```typescript
import { projectAccessor, taskAccessor, agentAccessor } from './src/backend/resource_accessors';
import { TaskState, AgentType } from '@prisma/client';

async function test() {
  // Create project
  const project = await projectAccessor.create({
    name: 'Test Project',
    slug: 'test-project-' + Date.now(),
    repoPath: '/tmp/test-repo',
    worktreeBasePath: '/tmp/worktrees',
  });
  console.log('Created project:', project.id);

  // Create top-level task
  const topLevelTask = await taskAccessor.create({
    projectId: project.id,
    title: 'Test Top-Level Task',
  });
  console.log('Created top-level task:', topLevelTask.id);

  // Create subtask
  const subtask = await taskAccessor.create({
    projectId: project.id,
    parentId: topLevelTask.id,
    title: 'Test Subtask',
  });
  console.log('Created subtask:', subtask.id);

  // Create agent
  const agent = await agentAccessor.create({
    type: AgentType.WORKER,
  });
  console.log('Created agent:', agent.id);

  // Cleanup
  await taskAccessor.delete(subtask.id);
  await taskAccessor.delete(topLevelTask.id);
  await projectAccessor.delete(project.id);
  await agentAccessor.delete(agent.id);

  console.log('Test passed!');
}

test();
```

Run:
```bash
npx tsx test-accessors.ts
```

## Troubleshooting

### Docker Issues

**Error: "Cannot connect to the Docker daemon"**

Solution:
```bash
# Start Docker Desktop or Docker daemon
# On macOS: Open Docker Desktop
# On Linux: sudo systemctl start docker
```

**Error: "Port 5432 is already in use"**

Solution:
```bash
# Find what's using the port
sudo lsof -i :5432

# Stop the conflicting service or change the port in docker-compose.yml
```

### Database Issues

**Error: "Migration failed"**

Solution:
```bash
# Reset the database
npx prisma migrate reset

# Re-run migrations
npm run db:migrate
```

**Error: "Cannot connect to database"**

Solution:
- Verify PostgreSQL is running: `docker ps`
- Check DATABASE_URL in `.env`
- Check PostgreSQL logs: `docker-compose logs postgres`

### Git Client Issues

**Error: "GIT_BASE_REPO_PATH environment variable is not set"**

Solution:
- Ensure `.env` file exists and has `GIT_BASE_REPO_PATH` set
- Verify the path points to a valid git repository

**Error: "Failed to create worktree"**

Solution:
- Ensure `GIT_BASE_REPO_PATH` points to a git repository
- Ensure you have write permissions to `GIT_WORKTREE_BASE`
- Check git version: `git --version` (should be 2.5+)

### GitHub CLI Issues

**Error: "gh: command not found"**

Solution:
```bash
# Install GitHub CLI
# macOS: brew install gh
# Linux: See https://github.com/cli/cli#installation
```

**Error: "Not authenticated"**

Solution:
```bash
gh auth login
# Follow the prompts
```

### Tmux Issues

**Error: "tmux: command not found"**

Solution:
```bash
# Install tmux
# macOS: brew install tmux
# Linux: sudo apt-get install tmux
```

### Node.js / TypeScript Issues

**Error: "Cannot find module"**

Solution:
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Regenerate Prisma client
npm run db:generate
```

**Error: "TypeScript compilation errors"**

Solution:
```bash
# Check tsconfig.json is present
# Ensure all dependencies are installed
npm install

# Try building
npx tsc --noEmit
```

## Next Steps

Once all verification tests pass, Phase 0 is complete!

Next phases:
- **Phase 1**: MCP infrastructure and mail system
- **Phase 2**: Supervisor agent implementation
- **Phase 3**: Orchestrator agent implementation
- **Phase 4**: Worker agent implementation

See the respective PHASE-*.md files for details.

## Getting Help

If you encounter issues not covered in this guide:

1. Check the main README.md
2. Review the DESIGN.md for architecture details
3. Check Docker logs: `docker-compose logs`
4. Check application logs in the terminal windows
5. Verify all environment variables are set correctly

## Summary Checklist

Before proceeding to Phase 1, ensure:

- [ ] PostgreSQL is running and accessible
- [ ] Prisma migrations are applied
- [ ] All environment variables are configured
- [ ] Backend server starts without errors
- [ ] Frontend loads at http://localhost:3000
- [ ] Inngest dev server runs at http://localhost:8288
- [ ] Git client can create/delete worktrees
- [ ] GitHub CLI is authenticated
- [ ] Tmux client can create/kill sessions
- [ ] All resource accessors work (tested via scripts)
- [ ] Prisma Studio can view and edit records
