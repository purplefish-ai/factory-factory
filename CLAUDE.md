# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev:all       # Start frontend + backend + Inngest
pnpm db:migrate    # Run Prisma migrations
pnpm db:generate   # Regenerate Prisma client after schema changes
pnpm check:fix     # Lint + format with Biome
pnpm typecheck     # TypeScript checking
pnpm build:all     # Build for production
```

## Architecture

Three-tier agent hierarchy:

```
Orchestrator (1 per system) → monitors health, manages supervisors
    └── Supervisor (1 per top-level task) → breaks down tasks, reviews/merges PRs
            └── Worker (1 per subtask) → implements in isolated git worktree
```

Agents communicate via Mail system and are triggered by Inngest events (`task.top_level.created` → supervisor, `task.created` → worker). PRs are merged sequentially to avoid complex conflicts.

## Code Patterns

- **Path aliases:** `@/*` → `src/`, `@prisma-gen/*` → `prisma/generated/`
- **Backend imports:** No `.js` extension needed (tsx handles module resolution)
- **Database access:** All queries go through `src/backend/resource_accessors/`
- **Agent tools:** MCP tools in `src/backend/routers/mcp/`, permissions per agent type in `permissions.ts`
