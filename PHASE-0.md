# Phase 0: Foundation & Infrastructure

## Overview
Set up the foundational infrastructure for FactoryFactory: database, core clients, basic project structure, and development environment.

## Goals
- PostgreSQL database running in Docker
- Prisma schema and migrations working
- Basic resource accessors for data access
- Git, GitHub, and Tmux clients (standalone, no agent integration)
- Validate required external tools (`gh` CLI)
- Basic Next.js app shell
- Basic Inngest infrastructure
- Test repository configured (`~/Programming/monorepo`)

## Prerequisites
- Node.js 18+ installed
- Docker and Docker Compose installed
- `gh` CLI installed and authenticated
- Claude API key available
- Access to `~/Programming/monorepo` for testing

## Implementation Steps

### 1. Project Initialization
- [ ] Initialize Node.js project with TypeScript
  - [ ] Create `package.json` with workspace configuration
  - [ ] Add TypeScript configuration (`tsconfig.json`)
  - [ ] Set up ESLint and Prettier
  - [ ] Add `.gitignore` for Node.js, Next.js, and IDE files

### 2. Docker Compose Setup
- [ ] Create `docker-compose.yml` with PostgreSQL service
  - [ ] PostgreSQL 15+ image
  - [ ] Volume for data persistence
  - [ ] Port mapping (5432:5432)
  - [ ] Environment variables for credentials
- [ ] Create `.env.example` template
- [ ] Create `.env` file (gitignored) with actual credentials
- [ ] Test: `docker-compose up -d` starts PostgreSQL
- [ ] Test: Can connect to PostgreSQL with `psql` or GUI client

### 3. Prisma Setup
- [ ] Install Prisma and Prisma Client dependencies
- [ ] Initialize Prisma: `npx prisma init`
- [ ] Create full Prisma schema in `prisma/schema.prisma`:
  - [ ] Epic model with all fields
  - [ ] Task model with all fields
  - [ ] Agent model with all fields
  - [ ] Mail model with all fields
  - [ ] DecisionLog model with all fields
  - [ ] All enums (EpicState, TaskState, AgentType, AgentState)
  - [ ] All relations and indexes
- [ ] Create initial migration: `npx prisma migrate dev --name init`
- [ ] Generate Prisma Client: `npx prisma generate`
- [ ] Test: Run Prisma Studio (`npx prisma studio`) and manually create test records

### 4. Resource Accessors
- [ ] Create `src/backend/resource_accessors/` directory
- [ ] Implement `epic.accessor.ts`:
  - [ ] `create(data)` - Create epic
  - [ ] `findById(id)` - Get epic by ID
  - [ ] `update(id, data)` - Update epic
  - [ ] `list(filters)` - List epics with optional filters
- [ ] Implement `task.accessor.ts`:
  - [ ] `create(data)` - Create task
  - [ ] `findById(id)` - Get task by ID
  - [ ] `update(id, data)` - Update task
  - [ ] `list(filters)` - List tasks with optional filters
  - [ ] `findByEpicId(epicId)` - Get all tasks for an epic
- [ ] Implement `agent.accessor.ts`:
  - [ ] `create(data)` - Create agent
  - [ ] `findById(id)` - Get agent by ID
  - [ ] `update(id, data)` - Update agent
  - [ ] `list(filters)` - List agents
  - [ ] `findByType(type)` - Get agents by type
- [ ] Implement `mail.accessor.ts`:
  - [ ] `create(data)` - Create mail
  - [ ] `findById(id)` - Get mail by ID
  - [ ] `update(id, data)` - Update mail (mark as read)
  - [ ] `listInbox(agentId)` - Get unread mail for agent
  - [ ] `listHumanInbox()` - Get mail for human
- [ ] Implement `decision-log.accessor.ts`:
  - [ ] `create(data)` - Create log entry
  - [ ] `findByAgentId(agentId, limit)` - Get logs for agent
  - [ ] `findRecent(limit)` - Get recent logs across all agents
- [ ] Test: Write simple test scripts to verify CRUD operations work

### 5. Git Client
- [ ] Create `src/backend/clients/git.client.ts`
- [ ] Implement Git client class:
  - [ ] `createWorktree(name, baseBranch)` - Create git worktree
    - [ ] Create worktree directory under `GIT_WORKTREE_BASE`
    - [ ] Create new branch from `baseBranch`
    - [ ] Return worktree path
  - [ ] `deleteWorktree(name)` - Remove worktree
  - [ ] `getWorktreePath(name)` - Get absolute path to worktree
  - [ ] `getBranchName(worktreeName)` - Get branch name from worktree
  - [ ] `checkWorktreeExists(name)` - Check if worktree exists
- [ ] Add environment variables:
  - [ ] `GIT_BASE_REPO_PATH` - Path to main repository
  - [ ] `GIT_WORKTREE_BASE` - Base directory for worktrees
- [ ] Test: Manually create and delete worktrees using the client

### 6. GitHub Client
- [ ] Create `src/backend/clients/github.client.ts`
- [ ] Implement GitHub client class (wrapper around `gh` CLI):
  - [ ] `createPR(from, to, title, description)` - Create PR
    - [ ] Use `gh pr create` command
    - [ ] Return PR URL
  - [ ] `getPRStatus(prUrl)` - Get PR status
    - [ ] Use `gh pr view` command
    - [ ] Return state and review status
  - [ ] `mergePR(prUrl)` - Merge PR
    - [ ] Use `gh pr merge` command
    - [ ] Return merge commit SHA
  - [ ] `checkInstalled()` - Verify `gh` CLI is installed
  - [ ] `checkAuthenticated()` - Verify `gh` is authenticated
- [ ] Test: Verify `gh` CLI is installed and authenticated
- [ ] Test: Manually create a test PR using the client

### 7. Tmux Client
- [ ] Create `src/backend/clients/tmux.client.ts`
- [ ] Implement Tmux client class:
  - [ ] `createSession(sessionName)` - Create tmux session
    - [ ] Use `tmux new-session -d -s <name>` command
    - [ ] Return session ID
  - [ ] `killSession(sessionName)` - Kill tmux session
    - [ ] Use `tmux kill-session -t <name>` command
  - [ ] `sessionExists(sessionName)` - Check if session exists
    - [ ] Use `tmux has-session -t <name>` command
  - [ ] `listSessions()` - List all tmux sessions
    - [ ] Use `tmux list-sessions` command
  - [ ] `sendKeys(sessionName, keys)` - Send keys to session
    - [ ] Use `tmux send-keys -t <name> <keys>` command
- [ ] Add environment variable:
  - [ ] `TMUX_SOCKET_PATH` - Socket path for tmux (optional)
- [ ] Test: Manually create and kill tmux sessions using the client

### 8. Basic Inngest Setup
- [ ] Install Inngest SDK dependencies
- [ ] Create `src/backend/inngest/` directory
- [ ] Create `src/backend/inngest/client.ts`:
  - [ ] Initialize Inngest client
  - [ ] Export client instance
- [ ] Create `src/backend/inngest/events.ts`:
  - [ ] Define TypeScript types for event schemas:
    - [ ] `epic.created`
    - [ ] `task.created`
    - [ ] `agent.completed`
    - [ ] `mail.sent`
    - [ ] `supervisor.check` (cron)
    - [ ] `orchestrator.check` (cron)
- [ ] Create `src/backend/inngest/functions/` directory (empty for now)
- [ ] Add environment variables:
  - [ ] `INNGEST_EVENT_KEY`
  - [ ] `INNGEST_SIGNING_KEY`
- [ ] Test: Start Inngest dev server (`npx inngest-cli dev`)

### 9. Next.js App Shell
- [ ] Install Next.js 14+ and React dependencies
- [ ] Create `src/frontend/` directory
- [ ] Initialize Next.js with App Router:
  - [ ] Create `src/frontend/app/layout.tsx` - Root layout
  - [ ] Create `src/frontend/app/page.tsx` - Homepage placeholder
  - [ ] Create `src/frontend/app/globals.css` - Global styles
- [ ] Install and configure TailwindCSS
- [ ] Create basic layout with navigation placeholder
- [ ] Test: `npm run dev` starts Next.js development server
- [ ] Test: Visit `http://localhost:3000` and see homepage

### 10. Environment Configuration
- [ ] Create comprehensive `.env.example` with all variables:
  - [ ] Database URL
  - [ ] Claude API key
  - [ ] Inngest keys
  - [ ] Git paths
  - [ ] Tmux socket path
  - [ ] Server ports
  - [ ] Model overrides (optional)
  - [ ] Permission modes (optional)
  - [ ] Notification settings (optional)
- [ ] Document each environment variable in comments
- [ ] Create `.env` from template and populate with real values
- [ ] Add `.env` to `.gitignore`

### 11. Test Repository Setup
- [ ] Verify `~/Programming/monorepo` exists and is a git repository
- [ ] Create a test worktree manually using git client
- [ ] Verify worktree appears in `GIT_WORKTREE_BASE`
- [ ] Delete test worktree
- [ ] Document test repository location in README

### 12. Basic Backend Server
- [ ] Create `src/backend/index.ts` - Main server entry point
- [ ] Set up Express server (for future tRPC and Inngest endpoints)
- [ ] Add health check endpoint (`GET /health`)
- [ ] Add Inngest serve endpoint placeholder
- [ ] Test: Start backend server and verify health check responds

### 13. Documentation
- [ ] Create `README.md` with:
  - [ ] Project overview
  - [ ] Prerequisites
  - [ ] Setup instructions
  - [ ] How to run development environment
  - [ ] Environment variable documentation
- [ ] Create `docs/PHASE-0-SETUP.md` with detailed setup walkthrough
- [ ] Document test repository setup

## Smoke Test Checklist

Run these tests manually to validate Phase 0 completion:

- [ ] **Docker Compose**: `docker-compose up -d` starts PostgreSQL without errors
- [ ] **Database Connection**: Can connect to PostgreSQL with `psql` or Prisma Studio
- [ ] **Prisma Migrations**: `npx prisma migrate status` shows migrations applied
- [ ] **Prisma Studio**: Can create/read/update/delete records in all tables
- [ ] **Git Client**: Can create and delete worktrees programmatically
- [ ] **GitHub CLI**: `gh auth status` shows authenticated, can create test PR
- [ ] **Tmux Client**: Can create and kill tmux sessions programmatically
- [ ] **Inngest Dev Server**: `npx inngest-cli dev` starts without errors
- [ ] **Next.js Dev Server**: `npm run dev` starts frontend on port 3000
- [ ] **Backend Server**: Backend server starts and health check responds
- [ ] **Resource Accessors**: Test script can CRUD epics, tasks, agents, mail, decision logs
- [ ] **Environment Variables**: All required env vars are set and working

## Success Criteria

- [ ] All smoke tests pass
- [ ] Can manually create epic and task records via Prisma Studio
- [ ] Can create git worktrees for test repository
- [ ] `gh` CLI is authenticated and functional
- [ ] Can create and manage tmux sessions
- [ ] Inngest dev server runs without errors
- [ ] Next.js app shows basic homepage
- [ ] Backend server responds to health check
- [ ] All resource accessors work correctly

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 0 complete: Foundation and infrastructure"
git tag phase-0-complete
```

## Notes

- This phase has no agent integration - all components are standalone
- Focus on getting infrastructure working correctly
- Manual testing is sufficient - no automated tests required yet
- If any external tool is missing, document installation instructions

## Next Phase

Phase 1 will build the MCP infrastructure and mail system on top of this foundation.
