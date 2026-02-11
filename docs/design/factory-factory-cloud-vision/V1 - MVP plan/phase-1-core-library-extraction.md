# Phase 1: Core Library Extraction

**Goal:** Extract FF's execution primitives into a standalone library so both desktop and cloud can use them.

## 1.1 Monorepo Conversion

Convert the current single-package repo into a pnpm monorepo:

```
factory-factory/
  pnpm-workspace.yaml          # NEW: packages: ['packages/*']
  packages/
    core/                       # NEW: @factory-factory/core
      src/
      package.json
      tsconfig.json
    desktop/                    # MOVED: everything from current src/, electron/
      src/
      electron/
      package.json
      tsconfig.json
  prisma/                       # Stays at root or moves into core
  docs/
  README.md
```

## 1.2 Extract `packages/core/`

Move the following into `packages/core/`:

**All 6 domains** (from `src/backend/domains/`):
- `session/` — Claude CLI process management (`ClaudeClient`, `ClaudeProcess`, protocol, `SessionManager`, lifecycle)
- `workspace/` — Workspace state machine, lifecycle, kanban state derivation, init policy
- `ratchet/` — Auto-fix polling loop, fixer session dispatch, CI/review detection, reconciliation
- `github/` — GitHub CLI wrapper, PR info extraction, CI status computation, review comments
- `terminal/` — Terminal subprocess management, TTY spawning
- `run-script/` — Startup and custom script execution

**Infrastructure services** (from `src/backend/services/`):
- `logger.service` — Structured logging (pino)
- `config.service` — Environment config
- `git-ops.service` — Git operations (clone, push, worktree management)
- `scheduler.service` — Interval-based task scheduling
- `file-lock.service` — File-based locking
- `rate-limiter.service` — GitHub API rate limit coordination

**Data layer:**
- Resource accessors (from `src/backend/resource_accessors/`)
- Prisma schema and migrations (SQLite, single-tenant)

**Bridge interfaces** — These are the public API surface. Each domain declares what it needs from other domains via bridge interfaces. Consumers (desktop, cloud) wire these up:

```typescript
// Exported from @factory-factory/core
export interface SessionBridge {
  startClaudeSession(id: string, opts?: SessionStartOptions): Promise<void>;
  stopClaudeSession(id: string): Promise<void>;
  getClient(id: string): ClaudeClient | null;
  injectCommittedUserMessage(id: string, msg: string): Promise<void>;
}

export interface GitHubBridge {
  extractPRInfo(url: string): PRInfo;
  getPRFullDetails(repo: string, pr: number): Promise<PRDetails>;
  fetchAndComputePRState(prUrl: string): Promise<PRState>;
}

// ... similar bridges for workspace, ratchet, etc.
```

## 1.3 Refactor `packages/desktop/`

Move everything that isn't core into `packages/desktop/`:
- Server (`server.ts`, `app-context.ts`)
- tRPC routers
- WebSocket handlers (`/chat`, `/terminal`, `/dev-logs`)
- Orchestration layer (bridge wiring — same logic, new import paths)
- Electron wrapper
- React UI
- CLI entrypoint

Update all imports:
```typescript
// Before
import { ClaudeClient } from '@/backend/domains/session/claude';

// After
import { ClaudeClient } from '@factory-factory/core';
```

## 1.4 Verify and Publish

- All existing tests pass
- Desktop app works identically (same commands: `pnpm dev`, `pnpm build`, `pnpm dev:electron`)
- Publish `@factory-factory/core` to npm with semantic versioning

## Done when

Desktop FF works exactly as before, but internally uses the extracted core library. `@factory-factory/core` is published to npm and installable by any consumer.
