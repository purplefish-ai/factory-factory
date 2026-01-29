# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev           # Start dev server (backend + frontend + migrations)
pnpm build         # Build for production
pnpm start         # Start production server
pnpm test          # Run tests with Vitest
pnpm check:fix     # Lint + format with Biome
pnpm typecheck     # TypeScript checking
pnpm db:migrate    # Run Prisma migrations
pnpm db:generate   # Regenerate Prisma client after schema changes
pnpm storybook     # Start Storybook for component development
```

## Architecture

Workspace-based coding environment where users interact with Claude Code through isolated workspaces:

```
Project (repo configuration)
    └── Workspace (isolated git worktree)
            ├── ClaudeSession (chat with Claude Code CLI)
            └── TerminalSession (PTY terminal)
```

**Key components:**
- **Frontend (Vite + React Router v7):** Project management, workspace UI, real-time chat
- **Backend (Express + tRPC):** API, WebSocket handlers for chat/terminal, git operations
- **Database (SQLite + Prisma):** Project, Workspace, Session persistence

**Real-time communication:**
- `/chat` WebSocket: Claude Code CLI streaming (JSON protocol)
- `/terminal` WebSocket: PTY terminal sessions per workspace

## Code Patterns

- **Path aliases:** `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`
- **Backend imports:** No `.js` extension needed (tsx handles module resolution)
- **Frontend routes:** `src/client/routes/` - explicit React Router v7 configuration in `src/client/router.tsx`
- **Database access:** All queries go through `src/backend/resource_accessors/`
- **tRPC routers:** `src/backend/trpc/` - project, workspace, session, admin
- **Claude integration:** `src/backend/claude/` - ClaudeClient, SessionManager, protocol parsing

## Database

SQLite database located at `~/factory-factory/data.db` by default. The path is determined by:
1. `DATABASE_PATH` env var (if set)
2. `$BASE_DIR/data.db` (if `BASE_DIR` is set)
3. `~/factory-factory/data.db` (default)

Query directly with sqlite3:
```bash
sqlite3 ~/factory-factory/data.db ".tables"              # List tables
sqlite3 ~/factory-factory/data.db "SELECT * FROM Project"  # Query projects
sqlite3 ~/factory-factory/data.db ".schema Workspace"     # Show table schema
```

## Data Model

- **Project:** Repository path, worktree base path, default branch, GitHub info
- **Workspace:** Isolated git worktree, branch name, PR URL, status (ACTIVE/COMPLETED/ARCHIVED)
- **ClaudeSession:** Chat session with Claude Code, workflow type, model, resume support
- **TerminalSession:** PTY terminal instance per workspace
