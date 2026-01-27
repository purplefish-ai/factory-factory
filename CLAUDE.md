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
- **Frontend (Next.js 16):** Project management, workspace UI, real-time chat
- **Backend (Express + tRPC):** API, WebSocket handlers for chat/terminal, git operations
- **Database (SQLite + Prisma):** Project, Workspace, Session persistence

**Real-time communication:**
- `/chat` WebSocket: Claude Code CLI streaming (JSON protocol)
- `/terminal` WebSocket: PTY terminal sessions per workspace

## Code Patterns

- **Path aliases:** `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`
- **Backend imports:** No `.js` extension needed (tsx handles module resolution)
- **Database access:** All queries go through `src/backend/resource_accessors/`
- **tRPC routers:** `src/backend/trpc/` - project, workspace, session, admin
- **Claude integration:** `src/backend/claude/` - ClaudeClient, SessionManager, protocol parsing

## Data Model

- **Project:** Repository path, worktree base path, default branch, GitHub info
- **Workspace:** Isolated git worktree, branch name, PR URL, status (ACTIVE/COMPLETED/ARCHIVED)
- **ClaudeSession:** Chat session with Claude Code, workflow type, model, resume support
- **TerminalSession:** PTY terminal instance per workspace
