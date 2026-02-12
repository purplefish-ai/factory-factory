# Stage 5: Domain Services Extraction

**Risk**: High
**Depends on**: Stage 4 (Claude protocol in core)
**Estimated scope**: ~30 files moved/adapted, ~20 files modified in desktop

## Goal

Extract the stateful domain services for ratchet, workspace, and session into core. After this stage, core contains all the workspace execution primitives needed by a cloud consumer. Desktop becomes a thin wiring layer that provides storage implementations and infrastructure deps.

## Problem

Domain services currently:
1. Import resource accessors directly (`workspaceAccessor`, `claudeSessionAccessor`)
2. Import logger and config singletons
3. Define bridge interfaces that reference Prisma types
4. Emit events consumed by the orchestration layer

These services need to accept storage interfaces and infrastructure deps via injection while preserving their existing behavior.

## What Gets Done

This stage is broken into 3 sub-phases, each independently verifiable. Do them in order.

### Sub-phase 5A: Extract Ratchet Domain (Cleanest Boundaries)

The ratchet domain is the ideal first extraction target because:
- All cross-domain deps are behind bridge interfaces
- Well-defined data access pattern (workspace accessor only)
- Self-contained polling/dispatch logic
- Smallest domain after terminal

**Files to move:**

| Source | Destination |
|--------|-------------|
| `domains/ratchet/bridges.ts` | `packages/core/src/ratchet/bridges.ts` |
| `domains/ratchet/ratchet.service.ts` | `packages/core/src/ratchet/ratchet.service.ts` |
| `domains/ratchet/ci-fixer.service.ts` | `packages/core/src/ratchet/ci-fixer.service.ts` |
| `domains/ratchet/ci-monitor.service.ts` | `packages/core/src/ratchet/ci-monitor.service.ts` |
| `domains/ratchet/fixer-session.service.ts` | `packages/core/src/ratchet/fixer-session.service.ts` |
| `domains/ratchet/reconciliation.service.ts` | `packages/core/src/ratchet/reconciliation.service.ts` |

**Dependency changes per file:**

`ratchet.service.ts`:
- `import { workspaceAccessor }` -> accept `WorkspaceStorage` via constructor/configure
- `import { createLogger }` -> accept `CreateLogger` via constructor/configure
- `import { configService }` -> accept `CoreServiceConfig` via constructor/configure
- `import { SERVICE_INTERVAL_MS, SERVICE_LIMITS }` -> use `CoreServiceConfig` values
- Bridge interfaces stay the same (already in bridges.ts)

`ci-fixer.service.ts`:
- Same pattern: replace accessor/logger/config singletons with injected deps

`fixer-session.service.ts`:
- `import { claudeSessionAccessor }` -> accept `SessionStorage` via deps
- `import { workspaceAccessor }` -> accept `WorkspaceStorage` via deps

`bridges.ts`:
- `import type { CIStatus } from '@prisma-gen/client'` -> `from '../types/enums.js'` (already in core from Stage 2)

**Service initialization pattern:**

```typescript
// packages/core/src/ratchet/ratchet.service.ts

export interface RatchetServiceDeps {
  createLogger: CreateLogger;
  workspaceStorage: WorkspaceStorage;
  sessionStorage: SessionStorage;
  config: CoreServiceConfig;
}

export class RatchetService {
  private deps!: RatchetServiceDeps;
  private sessionBridge!: RatchetSessionBridge;
  private githubBridge!: RatchetGitHubBridge;
  // ...

  configure(deps: RatchetServiceDeps) {
    this.deps = deps;
  }

  configureBridges(bridges: {
    session: RatchetSessionBridge;
    github: RatchetGitHubBridge;
    prSnapshot: RatchetPRSnapshotBridge;
  }) {
    this.sessionBridge = bridges.session;
    this.githubBridge = bridges.github;
    // ...
  }

  // ... existing methods, now using this.deps instead of singletons
}
```

**Desktop wiring:**

```typescript
// src/backend/orchestration/domain-bridges.orchestrator.ts (updated)
import { RatchetService } from '@factory-factory/core';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { createLogger } from '../services/logger.service';

const ratchetService = new RatchetService();
ratchetService.configure({
  createLogger,
  workspaceStorage: workspaceAccessor,
  sessionStorage: claudeSessionAccessor,
  config: { ratchetIntervalMs: 60000, /* ... */ },
});
```

### Sub-phase 5B: Extract Workspace State Services

Extract workspace services that operate on pure state and storage, leaving desktop-specific ones behind.

**Move to core:**

| Source | Destination | Notes |
|--------|-------------|-------|
| `domains/workspace/bridges.ts` | `packages/core/src/workspace/bridges.ts` | Bridge interface definitions |
| `domains/workspace/lifecycle/state-machine.service.ts` | `packages/core/src/workspace/state-machine.service.ts` | CAS-based state transitions |
| `domains/workspace/lifecycle/activity.service.ts` | `packages/core/src/workspace/activity.service.ts` | Session running/idle tracking |
| `domains/workspace/state/workspace-runtime-state.ts` | `packages/core/src/workspace/runtime-state.ts` | Runtime state type |
| `domains/workspace/query/workspace-query.service.ts` | Evaluate -- may stay | Complex bridge deps |

**Stay in desktop:**

| File | Reason |
|------|--------|
| `lifecycle/creation.service.ts` | Depends on git-ops, worktree, orchestration |
| `lifecycle/data.service.ts` | Thin wrapper around accessor; stays near Prisma |
| `worktree/worktree-lifecycle.service.ts` | OS-level git worktree management |
| `query/workspace-query.service.ts` | Many bridge deps; may stay in desktop |

**Dependency changes:**

`state-machine.service.ts`:
- Replace `workspaceAccessor` with `WorkspaceStorage`
- Replace `createLogger` with injected `CreateLogger`

`activity.service.ts`:
- Replace `createLogger` with injected `CreateLogger`
- This is mostly in-memory state; minimal storage deps

### Sub-phase 5C: Extract Session Lifecycle Services

Extract session management services that will be used by cloud.

**Move to core:**

| Source | Destination | Notes |
|--------|-------------|-------|
| `domains/session/bridges.ts` | `packages/core/src/session/bridges.ts` | Bridge interface definitions |
| `domains/session/session-domain.service.ts` | `packages/core/src/session/session-domain.service.ts` | In-memory state (Map-based) |
| `domains/session/lifecycle/session.service.ts` | `packages/core/src/session/session.service.ts` | Start/stop/create sessions |
| `domains/session/lifecycle/session.process-manager.ts` | `packages/core/src/session/process-manager.ts` | Process lifecycle |
| `domains/session/lifecycle/session.repository.ts` | `packages/core/src/session/repository.ts` | Session CRUD |
| `domains/session/lifecycle/session.prompt-builder.ts` | `packages/core/src/session/prompt-builder.ts` | Prompt construction |
| `domains/session/store/*.ts` | `packages/core/src/session/store/*.ts` | Session store (hydrator, queue, transcript, etc.) |
| `domains/session/data/session-data.service.ts` | `packages/core/src/session/session-data.service.ts` | Session data operations |

**Stay in desktop:**

| File | Reason |
|------|--------|
| `chat/chat-connection.service.ts` | WebSocket-coupled |
| `chat/chat-event-forwarder.service.ts` | Desktop notification bridge |
| `chat/chat-message-handlers.service.ts` | WebSocket message routing |
| `chat/chat-message-handlers/handlers/*.ts` | Individual handler implementations |
| `logging/session-file-logger.service.ts` | Desktop filesystem logging |

**Dependency changes:**

Same pattern as ratchet: replace accessor/logger/config singletons with `deps` injection.

## New Files

```
packages/core/src/
  ratchet/
    index.ts
    bridges.ts
    ratchet.service.ts
    ci-fixer.service.ts
    ci-monitor.service.ts
    fixer-session.service.ts
    reconciliation.service.ts
  workspace/
    bridges.ts
    state-machine.service.ts
    activity.service.ts
    runtime-state.ts
    index.ts                   # Updated from Stage 3
  session/
    index.ts
    bridges.ts
    session-domain.service.ts
    session.service.ts
    process-manager.ts
    repository.ts
    prompt-builder.ts
    session-data.service.ts
    store/
      session-store-registry.ts
      session-store.types.ts
      session-hydrator.ts
      session-process-exit.ts
      session-publisher.ts
      session-queue.ts
      session-replay-builder.ts
      session-runtime-machine.ts
      session-transcript.ts
  index.ts                     # Updated: re-exports all domains
```

## Modified Files (Desktop)

- `src/backend/domains/ratchet/index.ts` -- becomes re-export from core
- `src/backend/domains/ratchet/*.ts` -- removed (moved to core)
- `src/backend/domains/workspace/index.ts` -- partial re-exports from core
- `src/backend/domains/workspace/lifecycle/state-machine.service.ts` -- removed
- `src/backend/domains/workspace/lifecycle/activity.service.ts` -- removed
- `src/backend/domains/session/index.ts` -- partial re-exports from core
- `src/backend/domains/session/session-domain.service.ts` -- removed
- `src/backend/domains/session/lifecycle/*.ts` -- removed (moved to core)
- `src/backend/domains/session/store/*.ts` -- removed (moved to core)
- `src/backend/orchestration/domain-bridges.orchestrator.ts` -- updated wiring
- `src/backend/app-context.ts` -- imports from core, creates with desktop deps

## Tests to Add

### Port all existing domain tests to core

Each moved service file has co-located tests that move with it. Tests need their mock setups updated:

```typescript
// packages/core/src/ratchet/ratchet.service.test.ts
const mockDeps: RatchetServiceDeps = {
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  workspaceStorage: createMockWorkspaceStorage(),
  sessionStorage: createMockSessionStorage(),
  config: { ratchetIntervalMs: 1000, /* ... */ },
};
```

### New: Mock storage factories

```typescript
// packages/core/src/testing/mock-storage.ts
export function createMockWorkspaceStorage(): WorkspaceStorage {
  return {
    findRawById: vi.fn(),
    update: vi.fn(),
    transitionWithCas: vi.fn().mockResolvedValue({ count: 1 }),
    // ... all methods
  };
}

export function createMockSessionStorage(): SessionStorage {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    // ... all methods
  };
}
```

### New: Bridge mock factories

```typescript
// packages/core/src/testing/mock-bridges.ts
export function createMockRatchetSessionBridge(): RatchetSessionBridge {
  return {
    isSessionRunning: vi.fn().mockReturnValue(false),
    isSessionWorking: vi.fn().mockReturnValue(false),
    stopClaudeSession: vi.fn(),
    startClaudeSession: vi.fn(),
    getClient: vi.fn().mockReturnValue(null),
    injectCommittedUserMessage: vi.fn(),
  };
}
```

## Verification Checklist

Run after each sub-phase:

```bash
pnpm install
pnpm --filter @factory-factory/core build
pnpm --filter @factory-factory/core test
pnpm typecheck
pnpm test
pnpm check:fix
```

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Service initialization order issues | Medium | Desktop wiring in `domain-bridges.orchestrator.ts` already handles order; core just needs `configure()` called before `start()` |
| Missing bridge method in interface | Medium | TypeScript will catch at compile time when desktop wires bridges |
| Session store complexity | High | The session store has ~9 files with complex state management; move as a group, don't split |
| Event emission changes | Medium | Services emit events via typed emitters; ensure event types are exported from core |
| `reconciliation.service.ts` imports orchestration | Known | This is an existing exemption in dependency-cruiser; in core, reconciliation accepts a `reinitialize` callback instead |

## Design Decisions

### Why ratchet first?

Ratchet has:
- The cleanest bridge architecture (4 bridges, all well-defined)
- No WebSocket coupling
- No frontend coupling
- Self-contained polling loop
- Most representative of the "cloud use case" (auto-fix runs without user interaction)

If the extraction pattern works for ratchet, it works for everything.

### What stays in desktop permanently?

| Module | Reason |
|--------|--------|
| `chat/` (all WebSocket handlers) | WebSocket/tRPC transport coupling |
| `terminal/` domain | `node-pty` native module |
| `run-script/` domain | Local process management, port allocation |
| `github/` domain | `gh` CLI wrapper (desktop-specific) |
| `worktree/` service | OS-level git worktree management |
| `orchestration/` layer | Desktop-specific wiring; cloud has its own |
| `resource_accessors/` | Prisma implementations of storage interfaces |
| `routers/` | tRPC router definitions |
| `middleware/` | Express middleware |

### Why `configure()` instead of constructor injection?

The existing codebase uses a `configure()` pattern for bridge injection (called at startup by `domain-bridges.orchestrator.ts`). Extending this pattern to storage and infra deps maintains consistency with the existing architecture. Services are module-level singletons that get configured once at startup.

## Out of Scope

- npm publishing (Stage 6)
- Integration tests (Stage 6)
- Public API cleanup (Stage 6)
- Moving orchestration layer to core (stays in desktop)
