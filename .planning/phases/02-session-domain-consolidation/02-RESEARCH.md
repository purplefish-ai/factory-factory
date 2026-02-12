# Phase 2: Session Domain Consolidation - Research

**Researched:** 2026-02-10
**Domain:** TypeScript module consolidation, session lifecycle management, process management, WebSocket event forwarding
**Confidence:** HIGH

## Summary

Phase 2 is the largest consolidation phase in the refactor. It moves ~15,000 lines of session-related code from three locations (`src/backend/services/session*.ts`, `src/backend/services/chat*.ts`, `src/backend/claude/*`) into the session domain at `src/backend/domains/session/`. The existing `session-domain.service.ts` (358 lines) already owns in-memory session state (transcript, queue, runtime), so the consolidation absorbs the lifecycle orchestration, process management, WebSocket forwarding, and Claude CLI protocol layers around it.

The key architectural insight is that these modules form a natural dependency tree: the Claude CLI protocol (`protocol.ts`, `protocol-io.ts`, `types.ts`) is the lowest layer, process management (`process.ts`, `monitoring.ts`, `registry.ts`) builds on it, then permissions (`permissions.ts`, `permission-coordinator.ts`) and the unified client (`index.ts` / ClaudeClient) compose them, and finally the service layer (`session.service.ts`, `chat-event-forwarder.service.ts`, `chat-message-handlers.service.ts`) orchestrates everything. This layering should be preserved within the domain module -- not flattened.

The biggest risk is the high consumer count: `sessionService` is imported by 16+ files, `chatEventForwarderService` by 4, `chatMessageHandlerService` by 3, and the `claude/*` types/classes by 20+ files. All these import paths must be updated or re-exported. The "big-bang refactor" decision from the user means we can accept churn, but the Phase 9 (Import Rewiring) exists specifically for downstream consumers -- Phase 2 should leave re-export shims at old paths to avoid breaking the build mid-phase.

**Primary recommendation:** Move files in dependency-order batches (protocol layer first, then process/client layer, then service layer), leave re-export shims at old locations, eliminate the module-level `activeProcesses` Map in `registry.ts` (DOM-04), and ensure `pnpm typecheck` passes after each batch.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | Type system, path aliases, barrel files | Project standard |
| Vitest | 4.0.18 | Test runner with co-located tests | Project standard |
| Biome | 2.3.13 | Formatting and linting | Project standard |
| p-limit | (installed) | Concurrency mutex for process creation | Already used in `session.process-manager.ts` |
| pidusage | (installed) | Process resource monitoring | Already used in `monitoring.ts` |
| zod | (installed) | Schema validation for protocol messages | Already used in `types.ts`, `protocol.ts` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| ws | (installed) | WebSocket types for chat connection | Chat connection service types |
| node:events | built-in | EventEmitter for ClaudeProcess, ClaudeClient | Process/client event system |
| node:child_process | built-in | Spawning Claude CLI process | ClaudeProcess.spawn() |

### Alternatives Considered

None -- this phase exclusively reorganizes existing code. No new dependencies.

**Installation:**
```bash
# No new packages needed. All dependencies already installed.
```

## Architecture Patterns

### Recommended Domain Directory Structure

```
src/backend/domains/session/
├── index.ts                          # Barrel: public API for all consumers
├── session-domain.service.ts         # EXISTING: in-memory state (transcript, queue, runtime)
├── session-domain.service.test.ts    # EXISTING: tests for domain service
│
├── claude/                           # Claude CLI interaction layer (moved from src/backend/claude/)
│   ├── index.ts                      # Re-exports ClaudeClient as primary public type
│   ├── client.ts                     # ClaudeClient class (was claude/index.ts)
│   ├── process.ts                    # ClaudeProcess class
│   ├── process.test.ts               # Process tests
│   ├── protocol.ts                   # ClaudeProtocol NDJSON handler
│   ├── protocol.test.ts              # Protocol tests
│   ├── protocol-io.ts                # Protocol IO adapter
│   ├── permissions.ts                # Permission handlers
│   ├── permissions.test.ts           # Permission tests
│   ├── permission-coordinator.ts     # Permission coordination bridge
│   ├── permission-coordinator.test.ts
│   ├── monitoring.ts                 # Resource monitoring
│   ├── registry.ts                   # Process registry (refactored to instance-based)
│   ├── session.ts                    # SessionManager (JSONL history reader)
│   ├── session.test.ts               # Session history tests
│   ├── constants.ts                  # Timeout/limit constants
│   ├── types.ts                      # Protocol types + Zod schemas
│   ├── types.test.ts                 # Type validation tests
│   └── types/
│       └── process-types.ts          # Process status/resource types
│
├── lifecycle/                        # Session lifecycle orchestration (moved from services/)
│   ├── session.service.ts            # Start/stop/create client orchestration
│   ├── session.service.test.ts
│   ├── session.repository.ts         # DB access facade
│   ├── session.repository.test.ts
│   ├── session.prompt-builder.ts     # System prompt construction
│   ├── session.prompt-builder.test.ts
│   ├── session.process-manager.ts    # Client lifecycle with race protection
│   └── session.process-manager.test.ts
│
├── chat/                             # WebSocket chat layer (moved from services/)
│   ├── chat-connection.service.ts    # WS connection tracking
│   ├── chat-event-forwarder.service.ts  # Claude event -> WS forwarding
│   ├── chat-event-forwarder.service.test.ts
│   ├── chat-message-handlers.service.ts # Inbound message dispatch
│   ├── chat-message-handlers.service.test.ts
│   └── chat-message-handlers/        # Handler implementations (moved as-is)
│       ├── attachment-processing.ts
│       ├── attachment-processing.test.ts
│       ├── attachment-utils.ts
│       ├── attachment-utils.test.ts
│       ├── constants.ts
│       ├── interactive-response.ts
│       ├── interactive-response.test.ts
│       ├── registry.ts
│       ├── types.ts
│       ├── utils.ts
│       └── handlers/
│           ├── list-sessions.handler.ts
│           ├── load-session.handler.ts
│           ├── permission-response.handler.ts
│           ├── question-response.handler.ts
│           ├── queue-message.handler.ts
│           ├── remove-queued-message.handler.ts
│           ├── rewind-files.handler.ts
│           ├── set-model.handler.ts
│           ├── set-thinking-budget.handler.ts
│           ├── start.handler.ts
│           ├── start.handler.test.ts
│           ├── stop.handler.ts
│           └── user-input.handler.ts
│
├── logging/                          # Session file logging (moved from services/)
│   ├── session-file-logger.service.ts
│   └── session-file-logger.service.test.ts
│
├── data/                             # Session data access (moved from services/)
│   └── session-data.service.ts
│
└── store/                            # Session store internals (moved from services/session-store/)
    ├── session-hydrator.ts
    ├── session-process-exit.ts
    ├── session-publisher.ts
    ├── session-queue.ts
    ├── session-queue.test.ts
    ├── session-replay-builder.ts
    ├── session-replay-builder.test.ts
    ├── session-runtime-machine.ts
    ├── session-runtime-machine.test.ts
    ├── session-store-registry.ts
    ├── session-store.types.ts
    ├── session-transcript.ts
    └── session-transcript.test.ts
```

### Pattern 1: Re-export Shims at Old Paths

**What:** After moving a file, leave a re-export shim at the original location so downstream consumers continue to compile. This avoids updating every consumer in Phase 2 (that is Phase 9's job).

**When to use:** For every moved file that has external consumers.

**Example:**
```typescript
// src/backend/services/session.service.ts (SHIM - after move)
// Re-export from new location for backward compatibility.
// Will be removed in Phase 9 (Import Rewiring).
export { sessionService } from '@/backend/domains/session';
export type { ClientCreatedCallback } from '@/backend/domains/session';
```

```typescript
// src/backend/claude/index.ts (SHIM - after move)
// Re-export from new location for backward compatibility.
export * from '@/backend/domains/session/claude';
```

### Pattern 2: Instance-Based Registry (DOM-04)

**What:** Replace the module-level `const activeProcesses = new Map()` in `registry.ts` with an instance held by the domain service, eliminating global mutable state.

**When to use:** Required by DOM-04. Apply to `registry.ts` which has a bare module-scoped Map.

**Example (before):**
```typescript
// src/backend/claude/registry.ts (CURRENT)
const activeProcesses = new Map<string, RegisteredProcess>();
export function registerProcess(sessionId: string, process: RegisteredProcess): void {
  activeProcesses.set(sessionId, process);
}
```

**Example (after):**
```typescript
// src/backend/domains/session/claude/registry.ts (REFACTORED)
export class ProcessRegistry {
  private readonly processes = new Map<string, RegisteredProcess>();

  register(sessionId: string, process: RegisteredProcess): void {
    this.processes.set(sessionId, process);
  }
  unregister(sessionId: string): void {
    this.processes.delete(sessionId);
  }
  get(sessionId: string): RegisteredProcess | undefined {
    return this.processes.get(sessionId);
  }
  // ... other methods
}
```

The `ProcessRegistry` instance is owned by `SessionProcessManager` (or the domain service), not by a module-level singleton.

### Pattern 3: Dependency-Order File Movement

**What:** Move files in layers from lowest dependency to highest, ensuring each layer compiles before proceeding.

**When to use:** Always, for large consolidation phases.

**Batch order:**
1. **Types/Constants** (`claude/types.ts`, `claude/types/`, `claude/constants.ts`) -- no internal deps
2. **Protocol layer** (`claude/protocol.ts`, `claude/protocol-io.ts`) -- depends only on types
3. **Process layer** (`claude/process.ts`, `claude/monitoring.ts`, `claude/registry.ts`) -- depends on protocol + types
4. **Permissions layer** (`claude/permissions.ts`, `claude/permission-coordinator.ts`) -- depends on protocol + types
5. **Client layer** (`claude/index.ts` -> `claude/client.ts`) -- composes process + permissions
6. **Session history** (`claude/session.ts`) -- standalone, depends on types
7. **Session store** (`services/session-store/*`) -- depends on claude/session
8. **Session domain service** -- already in place, update internal imports
9. **Lifecycle services** (`session.service.ts`, `session.repository.ts`, etc.) -- depends on client + domain
10. **Chat services** (`chat-connection.service.ts`, `chat-event-forwarder.service.ts`, `chat-message-handlers.service.ts` + handlers) -- depends on client + domain
11. **Logging/Data** (`session-file-logger.service.ts`, `session-data.service.ts`) -- minimal deps

### Anti-Patterns to Avoid

- **Renaming/refactoring logic during the move:** This phase is about consolidation. Do not change behavior, APIs, or internal logic. Move files, update imports, leave shims. Refactoring is a separate concern.
- **Updating all downstream consumers in Phase 2:** Leave re-export shims. Phase 9 handles import rewiring across the codebase. Attempting to fix all imports in Phase 2 increases risk and review burden.
- **Flattening the directory structure:** The claude/ subdirectory has a clear layered architecture (protocol -> process -> client). Dumping all 15+ files into a flat `domains/session/` directory destroys discoverability. Preserve subdirectory structure.
- **Breaking the existing `sessionDomainService` singleton:** This class is already instantiated as a module-level singleton and consumed by 15+ files. Do not change its instantiation pattern in Phase 2.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import path updates | Manual search-replace | TypeScript compiler errors (`pnpm typecheck`) | Compiler catches every broken import |
| Circular dependency detection | Manual review | dependency-cruiser (`pnpm deps:check`) | Already configured with circular detection |
| Re-export validation | Manual checking | `pnpm typecheck` + existing tests | Type system validates all re-exports |
| Process lifecycle mutex | Custom lock | p-limit (already in use) | Already battle-tested in `session.process-manager.ts` |

**Key insight:** The TypeScript compiler is the primary validation tool for this phase. Every moved file and every re-export shim is validated by `pnpm typecheck`. Run it after every batch.

## Common Pitfalls

### Pitfall 1: Circular Dependencies from Barrel Files

**What goes wrong:** The session domain barrel (`index.ts`) re-exports from subdirectories that import each other, creating circular dependency chains that cause runtime `undefined` values.
**Why it happens:** TypeScript compiles circular imports but Node.js can return `undefined` for not-yet-initialized modules. A barrel that re-exports everything from `claude/`, `lifecycle/`, and `chat/` creates a giant cycle because chat imports from lifecycle which imports from claude.
**How to avoid:** The barrel file should export specific public APIs, not blanket `export *`. Each subdirectory should have its own barrel that only exports its public surface. Internal cross-subdirectory imports use direct file paths, not barrel paths.
**Warning signs:** Runtime errors like `TypeError: Cannot read property of undefined`, tests passing in isolation but failing together.

### Pitfall 2: SessionPublisher Depends on ChatConnectionService

**What goes wrong:** `session-store/session-publisher.ts` imports `chatConnectionService` to forward snapshots. When both move into the session domain, the import path changes but the dependency is legitimate.
**Why it happens:** The session store's publisher pushes data to WebSocket connections. This is a one-way dependency (store -> connection), not circular.
**How to avoid:** When moving `session-store/` to `domains/session/store/` and `chat-connection.service.ts` to `domains/session/chat/`, update the import in `session-publisher.ts` to the new relative path. This is an intra-domain dependency, which is fine.
**Warning signs:** `pnpm typecheck` failure in the publisher file after moving files.

### Pitfall 3: ChatMessageHandlers Import sessionService Circularly

**What goes wrong:** `chat-message-handlers/handlers/*.ts` import `sessionService` directly, and `session.service.ts` sets up `chatMessageHandlerService` via `setOnClientCreated` callback. When both are inside the session domain, this creates a circular module initialization.
**Why it happens:** The callback injection pattern (`setClientCreator`, `setOnClientCreated`) was specifically designed to break circular dependencies at runtime. The imports are for type references and function calls, not module-level initialization.
**How to avoid:** Maintain the callback injection pattern. The handlers should import from the lifecycle subdirectory, not from the barrel. The initialization wiring happens in the chat handler setup code (`routers/websocket/chat.handler.ts`), which is outside the domain.
**Warning signs:** `ERR_MODULE_NOT_FOUND` or `undefined` at runtime for injected callbacks.

### Pitfall 4: Test Mocking Paths Change

**What goes wrong:** Tests that `vi.mock('@/backend/claude')` or `vi.mock('@/backend/services/session.service')` will fail when files move because the mock path must match the actual module path.
**Why it happens:** Vitest resolves mock paths relative to the actual file system. When `claude/index.ts` moves to `domains/session/claude/index.ts`, the mock path must change.
**How to avoid:** When moving a file, update its co-located tests at the same time. For tests in other locations that mock moved modules, the re-export shims at old paths mean the old mock paths continue to work until Phase 9.
**Warning signs:** Tests that were passing start failing with "cannot find module" errors in mock declarations.

### Pitfall 5: Module-Level Singleton Instantiation Order

**What goes wrong:** Several services are instantiated at module load time (`export const sessionService = new SessionService()`). If the new module load order changes due to file relocation, constructors that depend on other singletons being initialized first may fail.
**Why it happens:** `SessionService` constructor takes optional `repository`, `promptBuilder`, `processManager` with defaults to module-level singletons. If those singletons aren't yet initialized when `SessionService` is constructed (circular import scenario), the defaults are `undefined`.
**How to avoid:** Constructor defaults to module-level singletons are evaluated lazily at call time in JavaScript -- the `??` operator evaluates the right side only when the left is nullish. However, if the import itself causes a circular dependency, the module-level `const` may not yet be assigned. Verify with `pnpm typecheck` and test suite after each batch.
**Warning signs:** `TypeError: Cannot read properties of undefined` at startup.

### Pitfall 6: Re-export Shims Create Knip False Positives

**What goes wrong:** Knip (dead code detector) flags re-export shims as "unused exports" because the real consumers now import from the new path.
**Why it happens:** During the transition period, both old and new import paths coexist. Once Phase 9 rewires imports, the old shims become truly dead code.
**How to avoid:** The ROADMAP already mentions "Domain barrel knip ignore: Added glob to knip ignore for placeholder barrels." Extend this pattern to re-export shims. Add patterns like `src/backend/services/session.service.ts` and `src/backend/claude/index.ts` to the knip ignore list.
**Warning signs:** Knip CI failures after adding shims.

## Code Examples

### Session Domain Barrel File (Public API)

```typescript
// src/backend/domains/session/index.ts
// Domain: session
// Public API for the session domain module.
// Consumers should import from '@/backend/domains/session' only.

// Core domain service (in-memory state management)
export { sessionDomainService } from './session-domain.service';

// Session lifecycle (start/stop/create)
export { sessionService } from './lifecycle/session.service';
export type { ClientCreatedCallback } from './lifecycle/session.service';

// Session data access
export { sessionDataService } from './data/session-data.service';

// Chat services
export { chatConnectionService } from './chat/chat-connection.service';
export type { ConnectionInfo } from './chat/chat-connection.service';
export { chatEventForwarderService } from './chat/chat-event-forwarder.service';
export { chatMessageHandlerService } from './chat/chat-message-handlers.service';
export type { ChatMessage } from './chat/chat-message-handlers.service';

// Session file logging
export { sessionFileLogger, SessionFileLogger } from './logging/session-file-logger.service';

// Claude client (primary type for consumers)
export type { ClaudeClient, ClaudeClientOptions } from './claude';
export type { RegisteredProcess } from './claude/registry';
export type { ResourceUsage } from './claude/types/process-types';

// Session history
export { SessionManager } from './claude/session';
export type { HistoryMessage, SessionInfo } from './claude/session';
```

### Re-export Shim Example

```typescript
// src/backend/services/session.service.ts (SHIM after move)
/**
 * @deprecated Import from '@/backend/domains/session' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export { sessionService, type ClientCreatedCallback } from '@/backend/domains/session';
```

### Process Registry Refactored (DOM-04)

```typescript
// src/backend/domains/session/claude/registry.ts
import type { ProcessStatus, ResourceUsage } from './types/process-types';

export interface RegisteredProcess {
  getStatus(): ProcessStatus;
  isRunning(): boolean;
  getPid(): number | undefined;
  interrupt(): Promise<void>;
  getResourceUsage(): ResourceUsage | null;
  getIdleTimeMs(): number;
}

export class ProcessRegistry {
  private readonly processes = new Map<string, RegisteredProcess>();

  register(sessionId: string, process: RegisteredProcess): void {
    this.processes.set(sessionId, process);
  }

  unregister(sessionId: string): void {
    this.processes.delete(sessionId);
  }

  get(sessionId: string): RegisteredProcess | undefined {
    return this.processes.get(sessionId);
  }

  isProcessWorking(sessionId: string): boolean {
    const process = this.processes.get(sessionId);
    if (!process) return false;
    const status = process.getStatus();
    if (status === 'starting' || status === 'running') return true;
    if (status === 'ready') return process.getIdleTimeMs() < 2000;
    return false;
  }

  isAnyProcessWorking(sessionIds: string[]): boolean {
    return sessionIds.some((id) => this.isProcessWorking(id));
  }

  getAll(): Map<string, RegisteredProcess> {
    return new Map(this.processes);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Session logic in 3 directories | Single domain module | Phase 2 (this phase) | All session operations in one place |
| Module-level Map in registry.ts | Instance-based ProcessRegistry class | Phase 2 (DOM-04) | Testable, no global state |
| `src/backend/claude/` as separate concern | Claude CLI layer as subdirectory of session domain | Phase 2 | Claude process is an implementation detail of sessions |
| Direct imports to scattered files | Barrel file at `@/backend/domains/session` | Phase 2 | Single import path for consumers |

## Consolidation Inventory

### Files Moving Into Domain (with source and target)

| Source | Target Subdirectory | Lines | Consumers |
|--------|-------------------|-------|-----------|
| `services/session.service.ts` | `lifecycle/` | 580 | 16+ |
| `services/session.service.test.ts` | `lifecycle/` | ~200 | 0 |
| `services/session.process-manager.ts` | `lifecycle/` | 328 | 2 |
| `services/session.process-manager.test.ts` | `lifecycle/` | ~200 | 0 |
| `services/session.repository.ts` | `lifecycle/` | 98 | 1 |
| `services/session.repository.test.ts` | `lifecycle/` | ~100 | 0 |
| `services/session.prompt-builder.ts` | `lifecycle/` | 73 | 1 |
| `services/session.prompt-builder.test.ts` | `lifecycle/` | ~100 | 0 |
| `services/session-data.service.ts` | `data/` | 93 | 4 |
| `services/session-file-logger.service.ts` | `logging/` | 363 | 4 |
| `services/session-file-logger.service.test.ts` | `logging/` | ~200 | 0 |
| `services/chat-connection.service.ts` | `chat/` | 129 | 5 |
| `services/chat-event-forwarder.service.ts` | `chat/` | 980 | 4 |
| `services/chat-event-forwarder.service.test.ts` | `chat/` | ~200 | 0 |
| `services/chat-message-handlers.service.ts` | `chat/` | 319 | 3 |
| `services/chat-message-handlers.service.test.ts` | `chat/` | ~200 | 0 |
| `services/chat-message-handlers/*` (15 files) | `chat/chat-message-handlers/` | 1587 | 0 (internal) |
| `services/session-store/*` (13 files) | `store/` | 1291 | 1 (domain svc) |
| `claude/*` (17 source + test files) | `claude/` | 9019 | 20+ |
| **Total** | | **~15,200** | |

### Global State to Eliminate (DOM-04)

| File | Global State | Replacement |
|------|-------------|-------------|
| `claude/registry.ts` | `const activeProcesses = new Map()` | `ProcessRegistry` class instance in `SessionProcessManager` |
| `chat-connection.service.ts` | `let chatWsMsgCounter = 0` | Instance field on class (already a class, just move the counter inside) |
| `chat-event-forwarder.service.ts` | Instance Maps on singleton class | Already instance-based, no change needed |
| `session-file-logger.service.ts` | `sessionLogs = new Map()` on singleton instance | Already instance-based, no change needed |

Note: Most services already use the class-with-instance-fields pattern (`private connections = new Map()`), which is instance-based. The only true module-level global state is `registry.ts`'s bare `activeProcesses` Map and the `chatWsMsgCounter` variable.

## Open Questions

1. **Should `fixer-session.service.ts` move into the session domain?**
   - What we know: `fixer-session.service.ts` (241 lines) creates and manages fixer sessions. It imports `sessionService` and `SessionManager`. It is NOT listed in the ROADMAP's Phase 2 source files.
   - What's unclear: Whether it belongs in the session domain or the ratchet domain (Phase 5).
   - Recommendation: Leave it in `services/` for now. It imports from the session domain but its primary concern is ratchet/CI-fix workflow orchestration, which is Phase 5's scope. It can import from the session domain barrel.

2. **Should `src/backend/agents/process-adapter.ts` move?**
   - What we know: It imports from `claude/index.ts` for types. Not listed in Phase 2 source files.
   - What's unclear: Whether it's session-domain-specific or cross-cutting.
   - Recommendation: Leave in `agents/`. It will import from the session domain barrel after Phase 9.

3. **Should the `claude/` subdirectory be renamed within the session domain?**
   - What we know: `src/backend/claude/` is a well-known path. Inside the session domain, `domains/session/claude/` preserves the name.
   - What's unclear: Whether a name like `cli/` or `process/` would be clearer.
   - Recommendation: Keep `claude/` to minimize diff noise and preserve grep-ability. The directory name is already well-understood by the team.

4. **How should `ClaudeProcess.spawn()` reference the registry after DOM-04?**
   - What we know: Currently `ClaudeProcess.spawn()` calls `registerProcess()` (a free function that writes to the module-level Map). After DOM-04, the registry is instance-based.
   - What's unclear: Whether to pass the registry into `ClaudeProcess.spawn()` or have the caller register after creation.
   - Recommendation: Have the caller (`SessionProcessManager.createClient()`) register the process after creation, rather than auto-registering inside `spawn()`. This removes the coupling between `ClaudeProcess` and the registry, making `ClaudeProcess` a pure process lifecycle class.

## Sources

### Primary (HIGH confidence)
- Existing codebase files: all files listed in the consolidation inventory were read and analyzed
- `src/backend/domains/session/session-domain.service.ts` -- existing domain service pattern
- `src/backend/domains/session/session-domain.service.test.ts` -- existing test pattern
- `src/backend/claude/index.ts` -- ClaudeClient re-export structure
- `src/backend/services/session-store/*` -- session store internal architecture
- `src/backend/app-context.ts` -- service registration and initialization
- Import graph analysis via grep across entire `src/` directory

### Secondary (MEDIUM confidence)
- `.planning/phases/01-foundation-domain-scaffolding/01-RESEARCH.md` -- Phase 1 conventions (barrel files, dep-cruiser rules)
- `.planning/ROADMAP.md` -- Phase sequencing, requirements, and prior decisions

### Tertiary (LOW confidence)
- None. All findings verified against codebase.

## Metadata

**Confidence breakdown:**
- File inventory and import graph: HIGH -- every file read and grep-verified
- Directory structure: HIGH -- follows existing domain pattern from Phase 1
- Re-export shim pattern: HIGH -- standard TypeScript re-export, proven in many projects
- DOM-04 registry refactoring: HIGH -- straightforward class extraction from module-level functions
- Pitfall analysis: HIGH -- derived from reading actual dependency chains in the code
- Move ordering: HIGH -- based on actual import graph analysis

**Research date:** 2026-02-10
**Valid until:** 2026-04-10 (stable codebase, no external dependency changes expected)
