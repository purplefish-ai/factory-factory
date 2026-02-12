# Stage 4: Claude Protocol and Process Management Extraction

**Risk**: Medium-High
**Depends on**: Stage 3 (infrastructure interfaces)
**Estimated scope**: ~25 files moved/adapted, ~10 files modified in desktop

## Goal

Extract the Claude CLI protocol layer -- the heart of what makes core valuable to cloud consumers -- from `src/backend/domains/session/claude/` into `packages/core/src/claude/`. This includes the NDJSON streaming protocol, process spawning, client API, session management, and permission coordination.

## Problem

The `session/claude/` subdirectory is the most complex module (~18 files) and the most valuable for cloud reuse. It currently imports from:

1. `@/backend/services/logger.service` -- `createLogger` singleton
2. `@/backend/services/config.service` -- `configService` singleton (for model defaults, timeouts)
3. `@/backend/services/constants` -- `SERVICE_LIMITS`, `SERVICE_INTERVAL_MS`
4. `@/backend/lib/event-emitter-types` -- typed event emitter utility
5. `@/backend/lib/claude-paths` -- Claude session file path resolution
6. `@/shared/claude/protocol/` -- protocol message types (shared with frontend)

All of these need to either move to core or be replaced with injected interfaces.

## What Gets Done

### Part A: Move Supporting Utilities to Core

| Source | Destination | Notes |
|--------|-------------|-------|
| `src/backend/lib/event-emitter-types.ts` | `packages/core/src/infra/event-emitter-types.ts` | Pure type utility, zero deps |
| `src/backend/lib/claude-paths.ts` | `packages/core/src/claude/claude-paths.ts` | Path resolution for Claude session files |
| `src/shared/claude/protocol/*.ts` (~14 files) | `packages/core/src/claude/protocol/*.ts` | Protocol message types and Zod schemas |
| `src/shared/claude/index.ts` | `packages/core/src/claude/shared-index.ts` | Re-export of model info, protocol types |

Desktop originals become re-exports from `@factory-factory/core`.

### Part B: Move Claude Module Files

Move all files from `src/backend/domains/session/claude/` to `packages/core/src/claude/`:

| File | Changes Needed |
|------|---------------|
| `types.ts`, `types/process-types.ts` | Update imports to use core protocol types |
| `protocol-io.ts` | Update event-emitter-types import |
| `protocol.ts` | Update event-emitter-types, types imports |
| `process.ts` | Replace `createLogger` with injected `CreateLogger`; replace `configService` with options |
| `client.ts` | Replace `createLogger` with injected `CreateLogger`; accept config via constructor options |
| `session.ts` | Replace `createLogger` with injected `CreateLogger`; replace `claude-paths` import |
| `registry.ts` | Replace `createLogger` with injected `CreateLogger` |
| `monitoring.ts` | Replace `createLogger` and config imports |
| `permissions.ts` | Minimal changes (pure logic) |
| `permission-coordinator.ts` | Replace `createLogger` |
| `constants.ts` | Replace `SERVICE_LIMITS` / `SERVICE_INTERVAL_MS` with values from `CoreServiceConfig` |
| `index.ts` | Updated barrel file |

### Part C: Dependency Injection Pattern

Replace singleton imports with constructor injection. Example for `ClaudeClient`:

**Before (desktop):**
```typescript
import { createLogger } from '@/backend/services/logger.service';
import { configService } from '@/backend/services/config.service';

const logger = createLogger('ClaudeClient');

export class ClaudeClient {
  constructor(options: ClaudeClientOptions) {
    // uses logger and configService directly
  }
}
```

**After (core):**
```typescript
import type { CreateLogger } from '../infra/logger.js';

export interface ClaudeClientDeps {
  createLogger: CreateLogger;
}

export class ClaudeClient {
  private logger: Logger;

  constructor(options: ClaudeClientOptions, deps: ClaudeClientDeps) {
    this.logger = deps.createLogger('ClaudeClient');
  }
}
```

The `deps` parameter pattern keeps the public API clean while making dependencies explicit and testable.

### Part D: Desktop Re-export Layer

Desktop's `src/backend/domains/session/claude/index.ts` becomes a thin layer that re-exports from core and provides a factory with desktop deps pre-injected:

```typescript
// src/backend/domains/session/claude/index.ts (after migration)
export {
  ClaudeClient,
  ClaudeProcess,
  ClaudeProtocol,
  ClaudeProtocolIO,
  // ... all types
} from '@factory-factory/core';

// Desktop-specific: pre-injected client factory
import { ClaudeClient as CoreClaudeClient } from '@factory-factory/core';
import { createLogger } from '@/backend/services/logger.service';

export function createDesktopClaudeClient(options: ClaudeClientOptions) {
  return new CoreClaudeClient(options, { createLogger });
}
```

## New Files

```
packages/core/src/
  claude/
    index.ts                  # Barrel file
    client.ts                 # ClaudeClient class
    process.ts                # ClaudeProcess class
    protocol.ts               # ClaudeProtocol
    protocol-io.ts            # ClaudeProtocolIO (NDJSON stream parser)
    session.ts                # SessionManager
    registry.ts               # ProcessRegistry
    monitoring.ts             # ClaudeProcessMonitor
    permissions.ts            # Permission handlers
    permission-coordinator.ts # Permission coordinator
    constants.ts              # Claude-specific constants
    claude-paths.ts           # Path resolution
    types.ts                  # Claude CLI protocol types
    types/
      process-types.ts        # Process status types
    protocol/
      index.ts                # Protocol type barrel
      agent.ts                # Agent types
      constants.ts            # Protocol constants
      content.ts              # Content types
      guards.ts               # Type guards
      interaction.ts          # Interactive request types
      messages.ts             # Message types
      models.ts               # Model definitions
      queued.ts               # Queued message types
      result-dedup.ts         # Result deduplication
      session.ts              # Session types
      state-machine.ts        # Protocol state machine
      websocket.ts            # WebSocket message types
  infra/
    event-emitter-types.ts    # Typed EventEmitter utility
```

## Modified Files (Desktop)

- `src/backend/domains/session/claude/index.ts` -- becomes re-export + desktop factory
- `src/backend/domains/session/claude/*.ts` -- removed (moved to core)
- `src/shared/claude/protocol/*.ts` -- become re-exports from `@factory-factory/core`
- `src/shared/claude/index.ts` -- becomes re-export
- `src/backend/lib/event-emitter-types.ts` -- becomes re-export
- `src/backend/lib/claude-paths.ts` -- becomes re-export
- Files importing from `session/claude/` internal paths -- update to use barrel

## Dependencies to Add to Core

```json
{
  "dependencies": {
    "zod": "^3.24.0"
  }
}
```

Zod is needed for protocol message schema validation. The version should match what root uses.

Note: `node:child_process` and `node:stream` are Node.js built-ins, not npm dependencies.

## Tests to Add

### Port existing Claude tests

All existing tests from `src/backend/domains/session/claude/*.test.ts` move to `packages/core/src/claude/`:

- `protocol-io.test.ts` -- NDJSON parsing tests
- `protocol.test.ts` -- message handling tests
- `client.test.ts` -- client API tests
- `process.test.ts` -- process spawning tests
- `session.test.ts` -- session manager tests
- `permissions.test.ts` -- permission handler tests

Tests need to provide mock `CreateLogger` instead of importing the singleton:

```typescript
const mockCreateLogger: CreateLogger = (component) => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
});
```

### New integration test

```typescript
// packages/core/src/claude/claude-integration.test.ts
describe('Claude protocol integration', () => {
  it('can parse a complete NDJSON conversation', () => {
    // Feed raw NDJSON lines through ProtocolIO -> Protocol -> Client
    // Verify message events are emitted correctly
  });
});
```

### Port shared protocol tests

Move `src/shared/claude/protocol.test.ts` to `packages/core/src/claude/protocol/`.

## Verification Checklist

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
| `configService` is deeply woven into Claude module | Medium | Audit every `configService` call; replace with explicit options |
| `processRegistry` singleton state | Medium | Keep singleton pattern but make it importable from core |
| Event emitter type changes break consumers | Low | Event types are preserved; only import paths change |
| `node:child_process` usage makes core non-portable | Acceptable | Core targets Node.js; cloud runs Node.js in VMs |
| Large number of files to move atomically | Medium | Move protocol types first, then process/client/session |

## Design Decisions

### Why `deps` parameter instead of a global DI container?

The `deps` parameter pattern is:
- **Explicit**: You can see exactly what each class needs
- **Testable**: Tests provide mock deps without global state
- **Portable**: No DI framework dependency in core
- **Simple**: Just TypeScript interfaces and objects

### Why move the shared protocol types to core?

`src/shared/claude/protocol/` contains types used by both frontend and backend. Since these types are framework-neutral and core needs them, they belong in core. Frontend continues to access them via re-exports from `src/shared/claude/`.

### Why keep `processRegistry` as a singleton?

`ProcessRegistry` tracks running Claude processes. In both desktop and cloud VMs, there's exactly one process registry per Node.js process. Singleton pattern is appropriate here; it just lives in core instead of desktop.

## Out of Scope

- Session lifecycle services (Stage 5)
- Chat/WebSocket handlers (stay in desktop permanently)
- Ratchet and workspace domain services (Stage 5)
