# Phase 6: Terminal Domain Consolidation - Research

**Researched:** 2026-02-10
**Domain:** Internal codebase refactoring -- consolidate terminal service into `src/backend/domains/terminal/`
**Confidence:** HIGH

## Summary

Phase 6 consolidates one source file (`src/backend/services/terminal.service.ts`, 544 lines) into the existing `src/backend/domains/terminal/` directory which currently has a placeholder `index.ts`. This is the simplest domain consolidation in the SRP refactor series -- a single file with a clean class-based singleton, no intra-domain dependencies, and straightforward external consumers.

The terminal service manages PTY instances via `node-pty` (lazy-loaded with `createRequire`), output buffering for reconnection resilience, and resource monitoring via `pidusage`. It has seven direct consumers: `app-context.ts`, `server.ts`, `terminal.handler.ts` (WebSocket), `terminal.mcp.ts` (MCP tool), `admin.trpc.ts`, `workspace.trpc.ts`, and `worktree-lifecycle.service.ts` (workspace domain). No existing unit tests exist for the terminal service -- TERM-03 requires creating them from scratch.

**Critical finding on TERM-02:** The requirement states "Static Maps replaced with instance-based state." However, the Maps in `terminal.service.ts` are **already instance fields** on the `TerminalService` class (lines 77-86: `private terminals`, `private outputListeners`, `private exitListeners`, `private activeTerminals`). There are no module-level Maps. The only `static` members are `static readonly` constants (`MONITORING_INTERVAL_MS`, `MAX_OUTPUT_BUFFER_SIZE`) which are stateless configuration. TERM-02 may already be satisfied, or it may be referring to the singleton export pattern (`export const terminalService = new TerminalService()`) which is the same pattern used across all domains. The planner should treat TERM-02 as "verify and confirm compliance" rather than "refactor Maps."

**Primary recommendation:** Follow the established move-and-shim pattern. Copy the file to the domain, create a shim at the old path, populate the barrel index, add a domain export smoke test, and write unit tests covering the public API with mocked `node-pty` and `pidusage`.

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node-pty | (project dep) | PTY process spawning for terminal sessions | Core to terminal functionality, lazy-loaded via createRequire |
| pidusage | (project dep) | Process CPU/memory monitoring | Resource usage snapshots for admin dashboard |
| vitest | (project dep) | Unit testing framework | Project standard |

### Supporting (already in project)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| logger.service | internal | Structured logging | Used for terminal lifecycle events |

### No new dependencies needed
This phase is purely internal refactoring. No new libraries are required.

## Architecture Patterns

### Recommended Domain Structure

```
src/backend/domains/terminal/
  index.ts                           # Barrel: selective named exports
  terminal.service.ts                # Moved from services/ (the TerminalService class + singleton)
  terminal.service.test.ts           # NEW: Unit tests for public API (TERM-03)
  terminal-domain-exports.test.ts    # NEW: Barrel export smoke test
```

This is a single-file domain. There is no benefit to splitting the 544-line file into sub-modules -- the class has clear internal structure with commented sections (Types, Service Class), and all methods relate to the single responsibility of terminal PTY management.

### Pattern 1: Move-and-Shim (Established)
**What:** Copy service to domain directory, update internal imports to relative paths, leave re-export shim at old path with `@deprecated` annotation.
**When to use:** The terminal.service.ts file.
**Example (verified from existing shims in codebase):**
```typescript
// src/backend/services/terminal.service.ts (becomes shim)
/**
 * @deprecated Import from '@/backend/domains/terminal' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  type CreateTerminalOptions,
  type CreateTerminalResult,
  type TerminalInstance,
  type TerminalOutput,
  type TerminalResourceUsage,
  terminalService,
} from '@/backend/domains/terminal/terminal.service';
```

### Pattern 2: Selective Barrel Exports (Established)
**What:** Named exports per module in index.ts. No blanket `export *`.
**When to use:** The domain's `index.ts` barrel file.
**Example:**
```typescript
// src/backend/domains/terminal/index.ts
// Domain: terminal
// Public API for the terminal domain module.
// Consumers should import from '@/backend/domains/terminal' only.

export {
  type CreateTerminalOptions,
  type CreateTerminalResult,
  type TerminalInstance,
  type TerminalOutput,
  type TerminalResourceUsage,
  terminalService,
} from './terminal.service';
```

### Pattern 3: Shim Uses Direct Module Path (Not Barrel)
**What:** Re-export shims import from the specific module file, not from the domain barrel, to avoid circular dependency risks.
**When to use:** The shim at `src/backend/services/terminal.service.ts`.
**Why:** Importing from the barrel (`@/backend/domains/terminal`) could create circular deps if the barrel re-exports from files that import from `services/`. Direct module path is safe.

### Pattern 4: Intra-Domain Relative, Cross-Domain Absolute
**What:** Within the domain directory, use `./` relative imports. Cross-domain uses `@/` absolute paths.
**When to use:** All imports within `src/backend/domains/terminal/`.
**Example for the moved terminal.service.ts:**
```typescript
// Cross-domain (absolute):
import { createLogger } from '@/backend/services/logger.service';
// The createRequire for node-pty and the pidusage import stay as-is (external packages)
```

### Anti-Patterns to Avoid
- **Blanket `export *` in barrel:** Breaks tree-shaking and hides circular dependency issues.
- **Moving the WebSocket handler into the domain:** The `terminal.handler.ts` is a WebSocket routing concern, not a domain service. It stays in `src/backend/routers/websocket/`.
- **Moving the MCP terminal tool into the domain:** `terminal.mcp.ts` is an MCP tool registration concern. It stays in `src/backend/routers/mcp/`.
- **Splitting the 544-line file:** Not warranted. The class is cohesive with a single responsibility.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import path resolution | Manual grep/replace across codebase | Shim at old path | Move-and-shim preserves all existing consumers without churn |
| Circular dependency detection | Manual analysis | Domain barrel export smoke tests | Catches `undefined` exports at test time |
| PTY mocking for tests | Real node-pty in tests | vi.mock for node-pty and pidusage | Native module requires compiled binary; mocking avoids test environment issues |

**Key insight:** The move-and-shim pattern means this phase requires zero changes to consumer files. All existing imports continue to work through shims. Consumer rewiring happens in Phase 9.

## Common Pitfalls

### Pitfall 1: Forgetting to Export All Types in Shim
**What goes wrong:** Consumer code like `import type { TerminalInstance } from '@/backend/services/terminal.service'` in `terminal.mcp.ts` breaks if the shim only re-exports the service singleton.
**Why it happens:** The terminal service exports 5 interfaces (`TerminalResourceUsage`, `TerminalInstance`, `CreateTerminalOptions`, `CreateTerminalResult`, `TerminalOutput`) plus the singleton. Easy to miss some.
**How to avoid:** Grep for all exports from the original file. The shim must re-export every name: `terminalService`, `TerminalResourceUsage`, `TerminalInstance`, `CreateTerminalOptions`, `CreateTerminalResult`, `TerminalOutput`.
**Warning signs:** `pnpm typecheck` fails on consumer files that import types.

### Pitfall 2: node-pty createRequire Path After Move
**What goes wrong:** The `createRequire(import.meta.url)` call in the terminal service uses the file's own URL to resolve `node-pty`. After moving the file to a different directory, `import.meta.url` changes, which could affect require resolution.
**Why it happens:** `createRequire` creates a `require` function scoped to the given URL's directory.
**How to avoid:** `node-pty` is in `node_modules/` at the project root. The `require('node-pty')` call resolves upward from any directory within the project, so the move should be transparent. However, verify this works by running `pnpm typecheck` and the terminal functionality.
**Warning signs:** Runtime error "Cannot find module 'node-pty'" when creating a terminal.

### Pitfall 3: Testing node-pty Native Module
**What goes wrong:** Tests that import terminal.service.ts without mocking node-pty will fail in CI if the native module isn't compiled.
**Why it happens:** node-pty requires native compilation (node-gyp or prebuild).
**How to avoid:** Mock the `createRequire` or mock the internal `getNodePty()` method. The service already lazy-loads node-pty via a private method, making it mockable. Best approach: mock the module-level `createRequire` return, or mock the entire terminal service's PTY interaction.
**Warning signs:** Test failures with "Cannot find module 'node-pty'" or segfaults.

### Pitfall 4: Testing pidusage
**What goes wrong:** Tests that call `updateTerminalResource` without mocking pidusage will attempt real process monitoring.
**Why it happens:** pidusage tries to read `/proc` or use system calls to measure resource usage.
**How to avoid:** Mock pidusage at the module level: `vi.mock('pidusage', () => ({ default: vi.fn() }))`.
**Warning signs:** Test failures on CI, flaky resource-dependent tests.

### Pitfall 5: Singleton Export Means Shared State Across Tests
**What goes wrong:** Tests that use the real `terminalService` singleton share state between test cases (terminals created in one test persist to the next).
**Why it happens:** The service is a class singleton exported at module scope.
**How to avoid:** Either (a) call `terminalService.cleanup()` in `beforeEach`, or (b) test the `TerminalService` class directly by instantiating fresh instances per test. Option (b) is better for isolation. Note: the class is not currently exported -- you may need to export it or test through the singleton with careful cleanup.
**Warning signs:** Tests pass individually but fail when run together.

### Pitfall 6: TERM-02 Misinterpretation
**What goes wrong:** Time wasted refactoring Maps that are already instance fields.
**Why it happens:** The requirement says "Static Maps replaced with instance-based state" but the Maps are already on the class instance. The word "static" in TERM-02 likely referred to the general anti-pattern, not to `static` keyword usage.
**How to avoid:** Verify the Maps are instance fields (they are: lines 77-86). Document in the plan that TERM-02 is already satisfied. The `static readonly` constants are stateless configuration and do not need to change.
**Warning signs:** Unnecessary code changes that add complexity.

## Code Examples

Verified patterns from the codebase:

### Shim File (following established pattern from github-cli.service.ts shim)
```typescript
// src/backend/services/terminal.service.ts (becomes shim)
/**
 * @deprecated Import from '@/backend/domains/terminal' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  type CreateTerminalOptions,
  type CreateTerminalResult,
  type TerminalInstance,
  type TerminalOutput,
  type TerminalResourceUsage,
  terminalService,
} from '@/backend/domains/terminal/terminal.service';
```

### Barrel Index (following workspace/github domain pattern)
```typescript
// src/backend/domains/terminal/index.ts
// Domain: terminal
// Public API for the terminal domain module.
// Consumers should import from '@/backend/domains/terminal' only.

// --- Terminal PTY management, output buffering, and monitoring ---
export {
  type CreateTerminalOptions,
  type CreateTerminalResult,
  type TerminalInstance,
  type TerminalOutput,
  type TerminalResourceUsage,
  terminalService,
} from './terminal.service';
```

### Domain Export Smoke Test (following github/workspace pattern)
```typescript
// src/backend/domains/terminal/terminal-domain-exports.test.ts
import { describe, expect, it } from 'vitest';
import { terminalService } from './index';

/**
 * Domain barrel export smoke test.
 *
 * Verifies that every public runtime export from the terminal domain barrel
 * is a real value (not `undefined` due to circular dependency breakage).
 * Static imports ensure the barrel can be loaded at module resolution time.
 */
describe('Terminal domain exports', () => {
  it('exports terminalService as an object', () => {
    expect(terminalService).toBeDefined();
  });
});
```

### Unit Test Pattern for Terminal Service (TERM-03)
```typescript
// src/backend/domains/terminal/terminal.service.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node-pty before import
const mockPtySpawn = vi.fn();
const mockPtyInstance = {
  pid: 12345,
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node:module', () => ({
  createRequire: () => (moduleName: string) => {
    if (moduleName === 'node-pty') {
      return { spawn: mockPtySpawn };
    }
    throw new Error(`Cannot find module '${moduleName}'`);
  },
}));

vi.mock('pidusage', () => ({
  default: vi.fn().mockResolvedValue({ cpu: 1.5, memory: 1024 }),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import AFTER mocks
// NOTE: The actual test file will need to import the class or singleton
// and test the public API methods.
```

### Methods to Test (Public API Coverage for TERM-03)
The public API of `TerminalService` consists of these methods:
1. `createTerminal(options)` -- creates PTY, returns id+pid
2. `writeToTerminal(workspaceId, terminalId, data)` -- writes to PTY
3. `resizeTerminal(workspaceId, terminalId, cols, rows)` -- resizes PTY
4. `destroyTerminal(workspaceId, terminalId)` -- kills PTY, cleans up
5. `getTerminal(workspaceId, terminalId)` -- retrieves instance
6. `getTerminalsForWorkspace(workspaceId)` -- lists workspace terminals
7. `onOutput(terminalId, listener)` -- registers output listener, returns unsubscribe
8. `onExit(terminalId, listener)` -- registers exit listener, returns unsubscribe
9. `destroyWorkspaceTerminals(workspaceId)` -- destroys all for workspace
10. `cleanup()` -- stops monitoring, destroys all
11. `getActiveTerminalCount()` -- returns count
12. `getAllTerminals()` -- returns all for admin view
13. `setActiveTerminal(workspaceId, terminalId)` -- sets active terminal
14. `getActiveTerminal(workspaceId)` -- gets active terminal
15. `clearActiveTerminal(workspaceId)` -- clears active terminal

## Dependency Map

### Source File and Its Dependencies

#### `terminal.service.ts` (544 lines)
- **Imports from:** `node:module` (createRequire), `node-pty` (type only), `pidusage`, `./logger.service`
- **Exported names:** `terminalService` (singleton), `TerminalResourceUsage`, `TerminalInstance`, `CreateTerminalOptions`, `CreateTerminalResult`, `TerminalOutput`

### Consumers (Direct Imports of terminal.service.ts)

| Consumer File | Imports Used | Access Pattern |
|--------------|-------------|----------------|
| `app-context.ts` | `terminalService` | Direct import for DI wiring |
| `services/index.ts` | `terminalService` | Re-export in services barrel |
| `server.ts` | via app-context | `context.services.terminalService.cleanup()` |
| `routers/websocket/terminal.handler.ts` | via AppContext type | `appContext.services.terminalService` (injected) |
| `routers/mcp/terminal.mcp.ts` | `terminalService`, `TerminalInstance` (type) | Direct import of singleton + type |
| `trpc/admin.trpc.ts` | via AppContext | `ctx.appContext.services.terminalService` |
| `trpc/workspace.trpc.ts` | via AppContext | `ctx.appContext.services.terminalService` |
| `domains/workspace/worktree/worktree-lifecycle.service.ts` | `terminalService` | Direct import: `@/backend/services/terminal.service` |
| `routers/mcp/terminal.mcp.test.ts` | mock of `../../services/terminal.service` | vi.mock path |

### Cross-Domain Dependencies After Move
| From (terminal domain) | To (external) | Import Path |
|------------------------|----------------|-------------|
| terminal.service | logger.service | `@/backend/services/logger.service` |
| terminal.service | node-pty (type) | `node-pty` (npm package, type-only import) |
| terminal.service | node:module | `node:module` (Node.js builtin) |
| terminal.service | pidusage | `pidusage` (npm package) |

**Note:** The terminal service has zero cross-domain imports. Its only non-npm dependency is the logger, which is shared infrastructure. This makes it the cleanest domain consolidation yet.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Flat services/ directory | Domain-organized modules | Phases 2-4 | Better cohesion, clearer ownership |
| Module-level singletons only | Instance fields on class singletons (DOM-04) | Phase 2 | Maps are already instance fields in terminal.service.ts |
| Direct imports everywhere | Shim at old path, direct import to domain | Phase 2 | Zero consumer changes during consolidation |

**Already correct (no changes needed for TERM-02):**
- `terminals` Map is a private instance field (line 77)
- `outputListeners` Map is a private instance field (line 80)
- `exitListeners` Map is a private instance field (line 83)
- `activeTerminals` Map is a private instance field (line 86)
- `monitoringInterval` is a private instance field (line 89)
- `MONITORING_INTERVAL_MS` and `MAX_OUTPUT_BUFFER_SIZE` are `static readonly` constants (stateless config, acceptable)

## Open Questions

1. **Should the TerminalService class be exported for direct instantiation in tests?**
   - What we know: Currently only the singleton `terminalService` is exported. Testing with fresh instances requires either exporting the class or calling `cleanup()` between tests.
   - What's unclear: Whether exporting the class is consistent with other domains.
   - Recommendation: Export the class alongside the singleton. This allows tests to create fresh instances for isolation. The session domain exports both its class (`SessionManager`) and singleton instances. Add `TerminalService` to the barrel exports.

2. **Is TERM-02 already satisfied?**
   - What we know: All Maps are private instance fields on the class, not module-level variables. The `static readonly` members are stateless constants.
   - What's unclear: Whether TERM-02 was written with awareness that the Maps were already instance fields, or if "static Maps" was a general description.
   - Recommendation: Document in the plan that TERM-02 is verified as already satisfied. No Map refactoring is needed. If the planner wants extra rigor, the plan can include a verification step that confirms no module-level Maps exist.

3. **Should terminal.mcp.ts tests update their mock path?**
   - What we know: `terminal.mcp.test.ts` mocks `../../services/terminal.service`. After the shim is in place, this mock path still resolves correctly (to the shim, which re-exports from the domain).
   - What's unclear: Whether to proactively update the test mock to use the domain path.
   - Recommendation: Leave the mock path as-is. The shim makes it transparent. Mock path updates happen in Phase 9 (Import Rewiring).

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of `src/backend/services/terminal.service.ts` (544 lines, full read)
- Direct codebase analysis of all 8 consumer files (grep for all import paths)
- Direct codebase analysis of Phase 2-4 established patterns (shims, barrels, domain export tests)
- `src/backend/domains/terminal/index.ts` -- current placeholder
- `src/backend/domains/github/index.ts` -- reference barrel pattern
- `src/backend/domains/github/github-domain-exports.test.ts` -- reference smoke test
- `src/backend/domains/workspace/workspace-domain-exports.test.ts` -- reference smoke test
- `src/backend/services/github-cli.service.ts` -- reference shim pattern
- `knip.json` -- domain service ignore glob already covers `src/backend/domains/**/*.service.ts`
- `src/backend/routers/mcp/terminal.mcp.test.ts` -- existing test mock patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies, purely internal refactoring
- Architecture: HIGH - Follows patterns directly established by Phases 2-4 in same codebase
- Pitfalls: HIGH - Identified through direct analysis of import graphs, code structure, and native module considerations
- Dependency map: HIGH - Comprehensive grep of all imports/consumers
- TERM-02 finding: HIGH - Direct code inspection confirms Maps are instance fields

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable -- internal refactoring patterns, not external dependency)
