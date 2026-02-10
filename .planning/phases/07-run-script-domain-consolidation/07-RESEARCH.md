# Phase 7: Run Script Domain Consolidation - Research

**Researched:** 2026-02-10
**Domain:** TypeScript module consolidation, run script execution, process state machine, startup script execution
**Confidence:** HIGH

## Summary

Phase 7 consolidates ~1,276 lines of run-script-related source code (plus ~600 lines of existing tests) from `src/backend/services/` into `src/backend/domains/run-script/`. This is one of the smallest consolidation phases, involving only 3 source files and 1 test file. The domain directory already exists with a placeholder `index.ts` created during Phase 1 (foundation scaffolding).

The three source files have a clean dependency hierarchy: `run-script-state-machine.service.ts` (281 lines) is the leaf dependency with no internal imports beyond the workspace accessor; `run-script.service.ts` (626 lines) depends on the state machine plus external services (`PortAllocationService`, `FactoryConfigService`); and `startup-script.service.ts` (369 lines) depends on `workspaceStateMachine` (workspace domain, via shim) and `workspaceAccessor`. The files have a modest consumer footprint: 5 unique external consumers (`app-context.ts`, `run-script.trpc.ts`, `init.trpc.ts`, `dev-logs.handler.ts`, and `worktree-lifecycle.service.ts` in the workspace domain).

The primary RS-02 requirement -- eliminating static Maps -- targets the 3 static Maps in `RunScriptService` (`runningProcesses`, `outputBuffers`, `outputListeners`) and the module-level `isShuttingDown` flag plus process signal handlers. The existing `RunScriptStateMachineService` class already uses instance-based state (no module-level globals). The `StartupScriptService` class also already uses instance-based state.

**Primary recommendation:** Move files in 2 batches (state machine first, then run-script + startup-script), convert `RunScriptService` from a static-methods class to an instance-based class (RS-02), leave re-export shims at old paths, and add co-located domain tests (RS-03). The process signal handlers (`SIGINT`/`SIGTERM`/`exit`) at the bottom of `run-script.service.ts` need special handling during the instance conversion.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | Type system, path aliases | Project standard |
| Vitest | 4.0.18 | Test runner with co-located tests | Project standard |
| Biome | 2.3.13 | Formatting and linting | Project standard |
| tree-kill | (installed) | Process tree termination | Already used in run-script.service.ts |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:child_process | built-in | spawn for script execution | Run script and startup script execution |
| node:fs/promises | built-in | File access checks | Startup script validation |
| node:path | built-in | Path manipulation | Script path validation |
| node:net | built-in | Port availability checking | Used by PortAllocationService (external dep) |

### Alternatives Considered

None -- this phase exclusively reorganizes existing code. No new dependencies.

**Installation:**
```bash
# No new packages needed. All dependencies already installed.
```

## Architecture Patterns

### Recommended Domain Directory Structure

```
src/backend/domains/run-script/
├── index.ts                                  # Barrel: public API for all consumers
├── run-script-state-machine.service.ts       # State machine (transitions, CAS, verify)
├── run-script-state-machine.service.test.ts  # Moved from services/ (existing tests)
├── run-script.service.ts                     # Process execution, output buffering, cleanup
├── run-script.service.test.ts                # NEW: co-located tests for public API (RS-03)
├── startup-script.service.ts                 # Startup/setup script execution
├── startup-script.service.test.ts            # NEW: co-located tests for public API (RS-03)
└── run-script-domain-exports.test.ts         # Barrel smoke test
```

### Pattern 1: Re-export Shims at Old Paths

**What:** After moving a file, leave a re-export shim at the original location so downstream consumers continue to compile.

**When to use:** For every moved file that has external consumers.

**Example:**
```typescript
// src/backend/services/run-script.service.ts (SHIM - after move)
/**
 * @deprecated Import from '@/backend/domains/run-script' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export { RunScriptService } from '@/backend/domains/run-script/run-script.service';
```

```typescript
// src/backend/services/run-script-state-machine.service.ts (SHIM - after move)
/**
 * @deprecated Import from '@/backend/domains/run-script' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  RunScriptStateMachineError,
  runScriptStateMachine,
  type TransitionOptions,
} from '@/backend/domains/run-script/run-script-state-machine.service';
```

```typescript
// src/backend/services/startup-script.service.ts (SHIM - after move)
/**
 * @deprecated Import from '@/backend/domains/run-script' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  startupScriptService,
  type StartupScriptResult,
} from '@/backend/domains/run-script/startup-script.service';
```

**CRITICAL: Use direct module paths in shims, NOT barrel imports.** Prior decision: "Direct module paths in shims (not barrel): Re-export shims use direct module path to avoid circular deps."

### Pattern 2: Instance-Based State (RS-02 / DOM-04)

**What:** Replace static Maps and module-level mutable variables with instance fields on the service class.

**When to use:** Required by RS-02. Apply to `RunScriptService` which has 3 static Maps and a module-level `isShuttingDown` flag.

**Before (current code):**
```typescript
export class RunScriptService {
  // Track running processes by workspace ID
  private static runningProcesses = new Map<string, ChildProcess>();
  // Output buffers by workspace ID
  private static outputBuffers = new Map<string, string>();
  // Output listeners by workspace ID
  private static outputListeners = new Map<string, Set<(data: string) => void>>();

  static async startRunScript(workspaceId: string) { ... }
  static async stopRunScript(workspaceId: string) { ... }
  static getOutputBuffer(workspaceId: string) { ... }
  static subscribeToOutput(workspaceId: string, listener) { ... }
  static async cleanup() { ... }
  static cleanupSync() { ... }
}

// Module-level state
let isShuttingDown = false;

// Module-level process signal handlers
process.on('SIGINT', async () => { ... });
process.on('SIGTERM', async () => { ... });
process.on('exit', () => { ... });
```

**After (instance-based):**
```typescript
export class RunScriptService {
  // RS-02: Instance fields replace static Maps
  private readonly runningProcesses = new Map<string, ChildProcess>();
  private readonly outputBuffers = new Map<string, string>();
  private readonly outputListeners = new Map<string, Set<(data: string) => void>>();
  private isShuttingDown = false;

  constructor(private readonly stateMachine: RunScriptStateMachineService) {}

  async startRunScript(workspaceId: string) { ... }
  async stopRunScript(workspaceId: string) { ... }
  getOutputBuffer(workspaceId: string) { ... }
  subscribeToOutput(workspaceId: string, listener) { ... }
  async cleanup() { ... }
  cleanupSync() { ... }

  /** Register process signal handlers for graceful shutdown. */
  registerShutdownHandlers(): void {
    process.on('SIGINT', async () => { ... });
    process.on('SIGTERM', async () => { ... });
    process.on('exit', () => { ... });
  }
}

export const runScriptService = new RunScriptService(runScriptStateMachine);
// Register shutdown handlers at module load time (same behavior as before)
runScriptService.registerShutdownHandlers();
```

### Pattern 3: Cross-Domain Imports Stay on Old Paths

**What:** When run-script domain files import from workspace domain (or other domains), keep using the old `src/backend/services/` shim paths.

**When to use:** Always, during consolidation phases. Cross-domain wiring is Phase 8's responsibility.

**Example:**
```typescript
// src/backend/domains/run-script/startup-script.service.ts
// CORRECT: Import through shim (not in domains/ path)
import { workspaceStateMachine } from '@/backend/services/workspace-state-machine.service';

// WRONG: Would violate no-cross-domain-imports
// import { workspaceStateMachine } from '@/backend/domains/workspace';
```

### Pattern 4: Intra-Domain Relative Imports

**What:** Files within the run-script domain import each other using relative `./` paths, not absolute `@/backend/domains/run-script/` paths.

**When to use:** Always for imports within the same domain.

**Example:**
```typescript
// src/backend/domains/run-script/run-script.service.ts
import { runScriptStateMachine } from './run-script-state-machine.service';
```

### Anti-Patterns to Avoid

- **Renaming/refactoring logic during the move:** Do not change behavior, APIs, or internal logic beyond the RS-02 instance conversion. Move files, update imports, leave shims.
- **Importing from `@/backend/domains/workspace/` or `@/backend/domains/session/`:** This would violate the `no-cross-domain-imports` dependency-cruiser rule. Keep using shim paths in `src/backend/services/`.
- **Moving external dependencies into the domain:** `PortAllocationService` and `FactoryConfigService` are NOT part of the run-script domain. They are utility services that should remain in `src/backend/services/`.
- **Removing process signal handlers:** The `SIGINT`/`SIGTERM`/`exit` handlers are critical for graceful shutdown. They must continue to work after the refactor.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import path updates | Manual search-replace | TypeScript compiler errors (`pnpm typecheck`) | Compiler catches every broken import |
| Circular dependency detection | Manual review | dependency-cruiser (`pnpm deps:check`) | Already configured with no-circular and no-cross-domain-imports rules |
| Re-export validation | Manual checking | `pnpm typecheck` + existing tests | Type system validates all re-exports |
| Process tree killing | Custom signal-based kill | tree-kill (already in use) | Handles process groups, OS differences |

**Key insight:** The TypeScript compiler is the primary validation tool for this phase. Every moved file and every re-export shim is validated by `pnpm typecheck`. Run it after every batch.

## Common Pitfalls

### Pitfall 1: Process Signal Handlers Must Survive Instance Conversion

**What goes wrong:** The module-level `process.on('SIGINT', ...)`, `process.on('SIGTERM', ...)`, and `process.on('exit', ...)` handlers at lines 601-626 of `run-script.service.ts` reference `RunScriptService.cleanup()` and `RunScriptService.cleanupSync()` via static methods. After converting to instance methods, these closures must reference the singleton instance.
**Why it happens:** The signal handlers are registered at module load time and capture references. If the instance isn't created yet when handlers fire, cleanup won't work.
**How to avoid:** Create the singleton instance at module level (`export const runScriptService = new RunScriptService(...)`) and have a `registerShutdownHandlers()` method that uses `this`. Call it immediately after construction. Alternatively, inline the handler registration in the module scope referencing the singleton.
**Warning signs:** Run scripts not being killed when the server process receives SIGINT/SIGTERM.

### Pitfall 2: `app-context.ts` Uses `typeof RunScriptService` (Static Class Pattern)

**What goes wrong:** `app-context.ts` declares `runScriptService: typeof RunScriptService` (line 35), meaning it expects the class constructor itself (for static method calls), not an instance. After converting from static methods to instance methods, the type needs to change.
**Why it happens:** The current pattern passes the class itself (not an instance) because all methods are static: `runScriptService: RunScriptService` at line 67.
**How to avoid:** After instance conversion, update `app-context.ts` to use the instance type: `runScriptService: RunScriptService` (instance type, not `typeof`). Update `createServices()` to pass the singleton instance instead of the class. All tRPC and WebSocket consumers already call methods on `ctx.appContext.services.runScriptService`, so the call sites don't change.
**Warning signs:** TypeScript errors about missing static methods, or `pnpm typecheck` failures in `app-context.ts`.

### Pitfall 3: `worktree-lifecycle.service.ts` Calls `RunScriptService.stopRunScript()` Statically

**What goes wrong:** `src/backend/domains/workspace/worktree/worktree-lifecycle.service.ts` line 693 calls `RunScriptService.stopRunScript(workspace.id)` as a static method. After instance conversion, this needs to call on the instance.
**Why it happens:** The workspace domain already imports `RunScriptService` from the old path. After the shim re-exports the new instance-based service, the static call pattern breaks.
**How to avoid:** The shim at `src/backend/services/run-script.service.ts` must re-export the singleton instance. The workspace domain file should import `runScriptService` (instance) instead of `RunScriptService` (class). This is a small API change: `RunScriptService.stopRunScript(id)` becomes `runScriptService.stopRunScript(id)`.
**Warning signs:** `pnpm typecheck` errors in `worktree-lifecycle.service.ts` about "Property 'stopRunScript' does not exist on type...".

### Pitfall 4: Test Mock Paths Change When Files Move

**What goes wrong:** The existing test file `run-script-state-machine.service.test.ts` uses `vi.mock('../db', ...)` which is relative to the test file's location. After moving, the relative path to `db.ts` changes.
**Why it happens:** Vitest resolves mock paths relative to the test file's location in the filesystem.
**How to avoid:** Update mock paths in the moved test file. From the new location `src/backend/domains/run-script/`, the db mock becomes `vi.mock('../../db', ...)`. Similarly, `vi.mock('./logger.service', ...)` becomes `vi.mock('../../services/logger.service', ...)` (or use absolute path `vi.mock('@/backend/services/logger.service', ...)`).
**Warning signs:** Tests failing with "Cannot find module" errors in vi.mock declarations.

### Pitfall 5: `startup-script.service.ts` Imports `workspaceStateMachine` from Workspace Domain

**What goes wrong:** `startup-script.service.ts` imports `workspaceStateMachine` from `./workspace-state-machine.service` (a workspace domain shim). After moving to `domains/run-script/`, this relative import breaks.
**Why it happens:** The relative path `./workspace-state-machine.service` only works from `src/backend/services/`.
**How to avoid:** Change the import to the absolute path `@/backend/services/workspace-state-machine.service` which resolves to the workspace domain shim. Do NOT import from `@/backend/domains/workspace/` (cross-domain violation).
**Warning signs:** `pnpm typecheck` failure in `startup-script.service.ts`.

### Pitfall 6: `RunScriptService` Constructor Dependency on State Machine

**What goes wrong:** Currently `run-script.service.ts` imports `runScriptStateMachine` at the top level and calls it directly in methods. After moving to the same domain directory, the import becomes a relative `./run-script-state-machine.service` import. But with instance conversion, the state machine should be injected via constructor for testability.
**Why it happens:** The current code uses module-level singleton imports.
**How to avoid:** Accept the state machine as a constructor parameter or import the singleton directly. Constructor injection is cleaner for testing but either approach works. The existing `RunScriptStateMachineService` is already instance-based (singleton via `export const runScriptStateMachine`).
**Warning signs:** Circular initialization if both files try to import each other's singletons at module load time.

## Code Examples

### Run Script Domain Barrel File (Public API)

```typescript
// src/backend/domains/run-script/index.ts
// Domain: run-script
// Public API for the run script domain module.
// Consumers should import from '@/backend/domains/run-script' only.

// State machine
export {
  RunScriptStateMachineError,
  runScriptStateMachine,
  type TransitionOptions,
} from './run-script-state-machine.service';

// Run script execution
export { RunScriptService, runScriptService } from './run-script.service';

// Startup script execution
export {
  startupScriptService,
  type StartupScriptResult,
} from './startup-script.service';
```

### Instance-Based RunScriptService

```typescript
// src/backend/domains/run-script/run-script.service.ts
import { type ChildProcess, spawn } from 'node:child_process';
import treeKill from 'tree-kill';
import { workspaceAccessor } from '../../resource_accessors/workspace.accessor';
import { FactoryConfigService } from '../../services/factory-config.service';
import { createLogger } from '../../services/logger.service';
import { PortAllocationService } from '../../services/port-allocation.service';
import { runScriptStateMachine } from './run-script-state-machine.service';

const logger = createLogger('run-script-service');
const MAX_OUTPUT_BUFFER_SIZE = 500 * 1024;

export class RunScriptService {
  // RS-02: Instance fields replace static Maps
  private readonly runningProcesses = new Map<string, ChildProcess>();
  private readonly outputBuffers = new Map<string, string>();
  private readonly outputListeners = new Map<string, Set<(data: string) => void>>();
  private isShuttingDown = false;

  async startRunScript(workspaceId: string): Promise<{
    success: boolean;
    port?: number;
    pid?: number;
    error?: string;
  }> {
    // ... same logic, but using this.runningProcesses, this.outputBuffers, etc.
  }

  // ... all other methods converted from static to instance

  registerShutdownHandlers(): void {
    process.on('SIGINT', async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      logger.info('Received SIGINT, cleaning up run scripts');
      await this.cleanup();
    });
    process.on('SIGTERM', async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      logger.info('Received SIGTERM, cleaning up run scripts');
      await this.cleanup();
    });
    process.on('exit', () => {
      if (!this.isShuttingDown) {
        this.cleanupSync();
      }
    });
  }
}

export const runScriptService = new RunScriptService();
runScriptService.registerShutdownHandlers();
```

### Domain Smoke Test

```typescript
// src/backend/domains/run-script/run-script-domain-exports.test.ts
import { describe, expect, it } from 'vitest';
import {
  RunScriptService,
  RunScriptStateMachineError,
  runScriptService,
  runScriptStateMachine,
  startupScriptService,
} from './index';

describe('Run script domain barrel exports', () => {
  it('exports runScriptService singleton', () => {
    expect(runScriptService).toBeDefined();
    expect(runScriptService).toBeInstanceOf(RunScriptService);
  });

  it('exports RunScriptService class', () => {
    expect(RunScriptService).toBeDefined();
    expect(typeof RunScriptService).toBe('function');
  });

  it('exports runScriptStateMachine singleton', () => {
    expect(runScriptStateMachine).toBeDefined();
  });

  it('exports RunScriptStateMachineError class', () => {
    expect(RunScriptStateMachineError).toBeDefined();
    expect(typeof RunScriptStateMachineError).toBe('function');
  });

  it('exports startupScriptService singleton', () => {
    expect(startupScriptService).toBeDefined();
  });
});
```

## Consolidation Inventory

### Files Moving Into Domain (with source and target)

| Source | Target | Lines | External Consumers |
|--------|--------|-------|-------------------|
| `services/run-script-state-machine.service.ts` | `domains/run-script/run-script-state-machine.service.ts` | 281 | 2 (app-context, run-script.service) |
| `services/run-script-state-machine.service.test.ts` | `domains/run-script/run-script-state-machine.service.test.ts` | 599 | 0 |
| `services/run-script.service.ts` | `domains/run-script/run-script.service.ts` | 626 | 4 (app-context, run-script.trpc, dev-logs.handler, worktree-lifecycle) |
| `services/startup-script.service.ts` | `domains/run-script/startup-script.service.ts` | 369 | 3 (app-context, init.trpc, worktree-lifecycle) |
| **Total** | | **Source: 1,276 + Tests: 599** | |

### New Files to Create

| File | Purpose |
|------|---------|
| `domains/run-script/run-script.service.test.ts` | Co-located tests for RunScriptService public API (RS-03) |
| `domains/run-script/startup-script.service.test.ts` | Co-located tests for StartupScriptService public API (RS-03) |
| `domains/run-script/run-script-domain-exports.test.ts` | Barrel smoke test |

### Static State to Eliminate (RS-02 / DOM-04)

| File | Static/Global State | Replacement |
|------|-------------------|-------------|
| `run-script.service.ts` | `private static runningProcesses = new Map<string, ChildProcess>()` | Instance field `this.runningProcesses` |
| `run-script.service.ts` | `private static outputBuffers = new Map<string, string>()` | Instance field `this.outputBuffers` |
| `run-script.service.ts` | `private static outputListeners = new Map<string, Set<...>>()` | Instance field `this.outputListeners` |
| `run-script.service.ts` | `let isShuttingDown = false` (module-level) | Instance field `this.isShuttingDown` |
| `run-script.service.ts` | `process.on('SIGINT'/'SIGTERM'/'exit', ...)` (module-level) | `registerShutdownHandlers()` method |

Note: `RunScriptStateMachineService` already uses instance-based state (no module-level globals). `StartupScriptService` also already uses instance-based state (no module-level globals).

### Import Graph: Who Imports What

**`run-script-state-machine.service.ts` imports:**
- `@prisma-gen/client` (types only: `Prisma`, `RunScriptStatus`, `Workspace`)
- `workspaceAccessor` from `../resource_accessors/workspace.accessor`
- `createLogger` from `./logger.service`

**`run-script.service.ts` imports:**
- `node:child_process` (spawn, ChildProcess)
- `tree-kill`
- `workspaceAccessor` from `../resource_accessors/workspace.accessor`
- `FactoryConfigService` from `./factory-config.service`
- `createLogger` from `./logger.service`
- `PortAllocationService` from `./port-allocation.service`
- `runScriptStateMachine` from `./run-script-state-machine.service`

**`startup-script.service.ts` imports:**
- `node:child_process` (spawn)
- `node:fs/promises` (access, constants)
- `node:path`
- `@prisma-gen/client` (types only: `Project`, `Workspace`)
- `workspaceAccessor` from `../resource_accessors/workspace.accessor`
- `SERVICE_LIMITS`, `SERVICE_TIMEOUT_MS` from `./constants`
- `createLogger` from `./logger.service`
- `workspaceStateMachine` from `./workspace-state-machine.service`

### Consumer Map: Who Imports These Services

| Consumer | Imports | Via |
|----------|---------|-----|
| `app-context.ts` | `RunScriptService`, `runScriptStateMachine`, `startupScriptService` | Direct from `./services/` |
| `run-script.trpc.ts` | Uses `ctx.appContext.services.runScriptService` | Via app-context |
| `dev-logs.handler.ts` | Uses `appContext.services.runScriptService` | Via app-context |
| `init.trpc.ts` | `startupScriptService` | Direct from `../../services/startup-script.service` |
| `worktree-lifecycle.service.ts` | `RunScriptService`, `startupScriptService` | Direct from `@/backend/services/` |

### Cross-Domain Dependencies

| Run-Script File | Imports From Other Domain | Import Path | Used For |
|-----------------|--------------------------|-------------|----------|
| `startup-script.service.ts` | `workspaceStateMachine` (workspace domain) | `./workspace-state-machine.service` | `markReady()`, `markFailed()` |

| Other Domain File | Imports From Run-Script | Import Path | Used For |
|-------------------|------------------------|-------------|----------|
| `worktree-lifecycle.service.ts` (workspace domain) | `RunScriptService` | `@/backend/services/run-script.service` | `stopRunScript()` |
| `worktree-lifecycle.service.ts` (workspace domain) | `startupScriptService` | `@/backend/services/startup-script.service` | `runStartupScript()`, `hasStartupScript()` |

**Strategy:** During Phase 7, all cross-domain imports remain on old `src/backend/services/` shim paths. Phase 8 will introduce an orchestration layer.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Run script logic in flat services/ | Single domain module | Phase 7 (this phase) | All run script operations in one place |
| Static Maps on RunScriptService class | Instance-based state | Phase 7 (RS-02) | Testable, no global state |
| Module-level process signal handlers | Instance method `registerShutdownHandlers()` | Phase 7 (RS-02) | Encapsulated lifecycle |

## Open Questions

1. **Should `RunScriptService` accept `runScriptStateMachine` via constructor injection or import it directly?**
   - What we know: Currently it imports the singleton at module level. Both files will be in the same domain directory, so import is straightforward.
   - What's unclear: Whether constructor injection improves testability enough to justify the change.
   - Recommendation: Use direct relative import (`./run-script-state-machine.service`). The state machine is a domain-internal dependency. Tests can mock it via `vi.mock('./run-script-state-machine.service')`. Constructor injection adds complexity without significant benefit since the state machine is always the same instance.

2. **How should `app-context.ts` handle the static-to-instance transition?**
   - What we know: `app-context.ts` currently declares `runScriptService: typeof RunScriptService` and passes the class itself. After instance conversion, it needs `runScriptService: RunScriptService` (instance type).
   - What's unclear: Whether `runScriptStateMachine` should also be removed from app-context (it's only used there, not by tRPC routes).
   - Recommendation: Keep both in app-context for now. Update the type from `typeof RunScriptService` to `RunScriptService` and pass the singleton instance. The `runScriptStateMachine` stays in app-context since it's already an instance (no change needed). Phase 8/9 can clean up app-context further.

3. **What tests should be written for RS-03 (co-located domain tests)?**
   - What we know: `run-script-state-machine.service.test.ts` already has 599 lines of thorough tests. No existing tests for `run-script.service.ts` or `startup-script.service.ts`.
   - What's unclear: How deep the new tests should go (unit vs integration, mocking child processes, etc.).
   - Recommendation: Focus on testing the public API surface. For `RunScriptService`: test that `startRunScript` calls state machine correctly, test `getOutputBuffer`/`subscribeToOutput`, test `cleanup`/`cleanupSync`. For `StartupScriptService`: test `hasStartupScript`, test `validateScriptPath`, test `validateScriptReadable`. Mock `spawn` and process events. These are the most testable parts without requiring actual process execution.

## Sources

### Primary (HIGH confidence)
- `src/backend/services/run-script.service.ts` -- full source analysis (626 lines)
- `src/backend/services/run-script-state-machine.service.ts` -- full source analysis (281 lines)
- `src/backend/services/startup-script.service.ts` -- full source analysis (369 lines)
- `src/backend/services/run-script-state-machine.service.test.ts` -- full test analysis (599 lines)
- `src/backend/domains/run-script/index.ts` -- placeholder from Phase 1
- `src/backend/domains/session/index.ts` -- barrel pattern reference
- `src/backend/domains/workspace/index.ts` -- barrel pattern reference
- `src/backend/app-context.ts` -- consumer analysis
- `src/backend/trpc/workspace/run-script.trpc.ts` -- tRPC consumer analysis
- `src/backend/routers/websocket/dev-logs.handler.ts` -- WebSocket consumer analysis
- `src/backend/domains/workspace/worktree/worktree-lifecycle.service.ts` -- cross-domain consumer
- `src/backend/trpc/workspace/init.trpc.ts` -- startup-script consumer
- `.dependency-cruiser.cjs` -- `no-cross-domain-imports` rule (lines 100-111)
- `.planning/phases/03-workspace-domain-consolidation/03-RESEARCH.md` -- Phase 3 patterns reference
- Existing shim files (e.g., `services/session-domain.service.ts`, `services/workspace-state-machine.service.ts`) -- shim pattern reference
- Import graph analysis via grep across entire `src/` directory

### Secondary (MEDIUM confidence)
- None needed. All findings from codebase analysis.

### Tertiary (LOW confidence)
- None. All findings verified against codebase.

## Metadata

**Confidence breakdown:**
- File inventory and import graph: HIGH -- every file read and grep-verified
- Directory structure: HIGH -- follows established Phase 2/3 domain pattern
- Re-export shim pattern: HIGH -- proven in Phase 2, 3, and 4
- RS-02 static state identification: HIGH -- grep-verified all static Maps and module-level state
- Cross-domain dependency analysis: HIGH -- grep-verified all imports in both directions
- Move ordering: HIGH -- based on actual import graph analysis
- RS-03 test strategy: MEDIUM -- based on testing patterns from existing domain tests, no complex process mocking verified

**Research date:** 2026-02-10
**Valid until:** 2026-04-10 (stable codebase, no external dependency changes expected)
