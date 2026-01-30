# Bugbot Configuration

## Project Overview

This is a workspace-based coding environment where users interact with Claude Code through isolated workspaces. The app runs as both a web application and an Electron desktop app.

## Architecture

- **Frontend:** Vite + React Router v7 + TailwindCSS
- **Backend:** Express + tRPC with WebSocket support
- **Database:** SQLite + Prisma ORM
- **Desktop:** Electron wrapper that spawns backend as child process

## Code Review Guidelines

### TypeScript Standards

- Use strict TypeScript - no `any` types without justification
- Prefer interfaces over type aliases
- Use path aliases: `@/*` for `src/`, `@prisma-gen/*` for `prisma/generated/`
- No `.js` extensions needed for backend imports (tsx handles resolution)

### Backend Rules

- All database queries must go through `src/backend/resource_accessors/`
- tRPC routers live in `src/backend/trpc/`
- Claude integration code is in `src/backend/claude/`
- WebSocket handlers: `/chat` for Claude CLI streaming, `/terminal` for PTY sessions

### Frontend Rules

- Routes are explicitly configured in `src/client/router.tsx`
- Use React Router v7 patterns
- Component files in `src/client/routes/`
- Prefer React Query for server state

### Security Concerns

- Check for command injection in terminal/shell operations
- Validate all user inputs, especially file paths
- Git worktree operations should be sandboxed to workspace directories
- WebSocket messages should be validated before processing

### Common Pitfalls

- Don't commit `.env` files or credentials
- Prisma schema changes require `pnpm db:generate` followed by migration
- Electron builds have different database paths than web mode
- Test both web and Electron modes when making backend changes

## Testing

Run tests with `pnpm test` (Vitest)
Lint with `pnpm check:fix` (Biome)
Typecheck with `pnpm typecheck`
