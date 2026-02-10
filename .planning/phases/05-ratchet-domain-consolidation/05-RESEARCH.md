# Phase 5: Ratchet Domain Consolidation - Research

**Researched:** 2026-02-10
**Domain:** Backend service consolidation (ratchet/auto-fix/CI monitoring)
**Confidence:** HIGH

## Summary

Phase 5 consolidates five services related to ratchet/auto-fix functionality into `src/backend/domains/ratchet/`. The source files are: `ratchet.service.ts` (1010 lines, the core polling loop and decision engine), `ci-fixer.service.ts` (181 lines, CI failure session creation), `ci-monitor.service.ts` (408 lines, legacy CI polling, already partially deprecated), `fixer-session.service.ts` (242 lines, shared session acquisition/dispatch), and `reconciliation.service.ts` (187 lines, workspace worktree reconciliation and orphan cleanup).

The ratchet domain already has a placeholder barrel at `src/backend/domains/ratchet/index.ts` created in Phase 1. The move-and-shim pattern is well-validated from Phases 2 and 3 (session and workspace domain consolidations). All five services have existing test files that must continue passing. The domain has clear internal dependencies (ratchet.service depends on fixer-session.service, ci-fixer depends on fixer-session.service, ci-monitor depends on ci-fixer.service) and cross-domain dependencies on the session domain and workspace accessors.

**Primary recommendation:** Copy all five services into `src/backend/domains/ratchet/`, organize into subdirectories by concern (polling, fixer, reconciliation), update internal imports to relative paths, create shims at old paths, add barrel export smoke test, and verify with `pnpm typecheck && pnpm test`.

## Standard Stack

This phase does not introduce new libraries. It reorganizes existing code following the established domain module pattern.

### Core Dependencies Used by Ratchet Services
| Library | Purpose | Import Location |
|---------|---------|-----------------|
| `p-limit` | Concurrency control for workspace checks | `ratchet.service.ts`, `ci-monitor.service.ts` |
| `@prisma-gen/client` | Enums: `CIStatus`, `RatchetState`, `SessionStatus` | All ratchet services |

### Cross-Domain Dependencies
| Dependency | Used By | Import Path |
|------------|---------|-------------|
| `sessionDomainService` | `ratchet.service.ts` | `@/backend/domains/session/session-domain.service` |
| `sessionService` | `ratchet.service.ts`, `ci-fixer.service.ts`, `ci-monitor.service.ts`, `fixer-session.service.ts` | `./session.service` (shim to session domain) |
| `SessionManager` | `fixer-session.service.ts` | `../claude/session` (shim to session domain) |
| `workspaceAccessor` | `ratchet.service.ts`, `ci-monitor.service.ts`, `fixer-session.service.ts`, `reconciliation.service.ts` | `../resource_accessors/workspace.accessor` |
| `claudeSessionAccessor` | `ratchet.service.ts`, `ci-monitor.service.ts`, `reconciliation.service.ts` | `../resource_accessors/claude-session.accessor` |
| `githubCLIService` | `ratchet.service.ts`, `ci-monitor.service.ts` | `./github-cli.service` |
| `configService` | `fixer-session.service.ts` | `./config.service` |
| `workspaceStateMachine` | `reconciliation.service.ts` | `./workspace-state-machine.service` (shim to workspace domain) |
| `initializeWorkspaceWorktree` | `reconciliation.service.ts` | `../trpc/workspace/init.trpc` |
| `buildRatchetDispatchPrompt` | `ratchet.service.ts` | `../prompts/ratchet-dispatch` |
| `RateLimitBackoff` | `ratchet.service.ts`, `ci-monitor.service.ts` | `./rate-limit-backoff` |
| `SERVICE_*` constants | Multiple services | `./constants` |
| `createLogger` | All services | `./logger.service` |

## Architecture Patterns

### Recommended Domain Structure
```
src/backend/domains/ratchet/
├── index.ts                              # Barrel exports (selective named exports)
├── ratchet-domain-exports.test.ts        # Barrel smoke test
├── polling/
│   ├── ratchet.service.ts                # Core polling loop + decision engine
│   └── ci-monitor.service.ts             # Legacy CI monitoring (deprecated)
├── fixer/
│   ├── fixer-session.service.ts          # Shared session acquisition/dispatch
│   ├── ci-fixer.service.ts              # CI failure fixer
│   └── ci-fixer.service.test.ts         # Existing tests (moved)
├── reconciliation/
│   └── reconciliation.service.ts        # Workspace/session orphan cleanup
└── __tests__/                            # Or co-located with modules
    ├── ratchet.service.test.ts           # Existing tests (moved)
    ├── fixer-session.service.test.ts     # Existing tests (moved)
    └── reconciliation.service.test.ts    # Existing tests (moved)
```

**Alternative (flat) structure:**
```
src/backend/domains/ratchet/
├── index.ts
├── ratchet-domain-exports.test.ts
├── ratchet.service.ts
├── ci-fixer.service.ts
├── ci-monitor.service.ts
├── fixer-session.service.ts
├── reconciliation.service.ts
├── ratchet.service.test.ts
├── ci-fixer.service.test.ts
├── fixer-session.service.test.ts
└── reconciliation.service.test.ts
```

**Recommendation:** Use the **flat structure**. The session domain uses subdirectories because it has 20+ files. The ratchet domain has only 5 source files + 4 test files. Subdirectories add unnecessary nesting for this size. This matches the workspace domain's flat approach for its smaller subdirectories (e.g., `query/` has one file, `state/` has three files).

### Pattern 1: Move-and-Shim (Validated in Phases 2-3)

**What:** Copy source file to domain directory, update internal imports to relative paths, replace original file with a re-export shim pointing to the new location.

**When to use:** Every file being consolidated into the domain.

**Example shim** (from workspace domain consolidation):
```typescript
/**
 * @deprecated Import from '@/backend/domains/ratchet' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export { ratchetService } from '@/backend/domains/ratchet/ratchet.service';
export type {
  RatchetAction,
  RatchetCheckResult,
  WorkspaceRatchetResult,
} from '@/backend/domains/ratchet/ratchet.service';
```

**Critical rule from prior phases:** Shims use direct module paths (e.g., `@/backend/domains/ratchet/ratchet.service`), NOT barrel imports (`@/backend/domains/ratchet`), to avoid circular dependency risks.

### Pattern 2: Intra-Domain Relative Imports

**What:** Once files are inside the domain, they import each other using relative paths (`./fixer-session.service`), not absolute paths (`@/backend/services/fixer-session.service`).

**Example:** After moving, `ratchet.service.ts` changes:
```typescript
// Before (absolute, cross-service):
import { fixerSessionService } from './fixer-session.service';

// After (relative, intra-domain):
import { fixerSessionService } from './fixer-session.service';  // same if flat
```

### Pattern 3: Cross-Domain Imports via Absolute Paths

**What:** Dependencies on other domains use absolute `@/` paths. The ratchet domain depends on the session domain, workspace accessors, and github CLI service.

**Example:**
```typescript
// Cross-domain: session domain
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
// Cross-domain: session service (via shim, acceptable during migration)
import { sessionService } from '@/backend/services/session.service';
// External service (not yet in a domain):
import { githubCLIService } from '@/backend/services/github-cli.service';
```

### Pattern 4: Selective Barrel Exports

**What:** The barrel `index.ts` uses named exports per module, never `export *`.

**Example:**
```typescript
// Domain: ratchet
// Public API for the ratchet domain module.

// Core ratchet service
export { ratchetService } from './ratchet.service';
export type { RatchetAction, RatchetCheckResult, WorkspaceRatchetResult } from './ratchet.service';

// CI fixer
export { ciFixerService } from './ci-fixer.service';
export type { CIFailureDetails, CIFixResult } from './ci-fixer.service';

// CI monitor (legacy)
export { ciMonitorService } from './ci-monitor.service';

// Fixer session management
export { fixerSessionService } from './fixer-session.service';
export type { AcquireAndDispatchInput, AcquireAndDispatchResult } from './fixer-session.service';

// Reconciliation
export { reconciliationService } from './reconciliation.service';
```

### Pattern 5: Barrel Export Smoke Test

**What:** A test file that imports every export from the barrel and asserts they are defined (not `undefined` from circular dep breakage).

**Example** (from workspace domain):
```typescript
import { describe, expect, it } from 'vitest';
import {
  ratchetService,
  ciFixerService,
  ciMonitorService,
  fixerSessionService,
  reconciliationService,
} from './index';

describe('Ratchet domain exports', () => {
  it('exports ratchetService as an object', () => {
    expect(ratchetService).toBeDefined();
  });
  // ... one test per export
});
```

### Anti-Patterns to Avoid

- **Barrel re-exports in shims:** Shims must re-export from the direct module path, never from `'@/backend/domains/ratchet'` (the barrel). This prevents circular dependency chains.
- **`export *` in barrels:** Prior phases established selective named exports. Using `export *` masks what the domain's public API actually is and can leak internal types.
- **Restructuring service internals during move:** This phase is about consolidation, not refactoring. Do not change the internal logic of the services. Move them as-is with only import path adjustments.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Re-export compatibility | Manual import rewriting in all consumers | Shim files at old paths | Validated pattern; consumers update in Phase 9 |
| Circular dependency detection | Manual dependency tracing | `pnpm typecheck` + barrel smoke test | TypeScript compiler catches circular deps as undefined imports |
| Test migration | Rewriting test mocks from scratch | Adjust `vi.mock()` paths only | Tests mock by path; update paths to match new locations |

## Common Pitfalls

### Pitfall 1: Mock Path Mismatch After Move
**What goes wrong:** Tests use `vi.mock('./fixer-session.service')` which resolves relative to the test file. After moving the service, the mock path must change.
**Why it happens:** `vi.mock()` paths are relative to the test file, not the module being mocked.
**How to avoid:** When moving test files, update all `vi.mock()` paths to reflect the new file location. If the test stays co-located with the source, relative paths remain the same. If using absolute paths like `vi.mock('../resource_accessors/...')`, adjust for the new depth.
**Warning signs:** Tests fail with "Cannot find module" or mocks don't take effect (real implementations run instead).

### Pitfall 2: Reconciliation Service's Unique Import Pattern
**What goes wrong:** `reconciliation.service.ts` imports from `../trpc/workspace/init.trpc`, which is unusual (most services don't import from the tRPC layer).
**Why it happens:** The reconciliation service calls `initializeWorkspaceWorktree` which lives in the tRPC layer rather than a service.
**How to avoid:** When moving reconciliation.service.ts, update this import path from `../trpc/workspace/init.trpc` to `@/backend/trpc/workspace/init.trpc` (absolute path since it's cross-domain).
**Warning signs:** TypeScript import resolution errors on `initializeWorkspaceWorktree`.

### Pitfall 3: CI Monitor is Partially Deprecated
**What goes wrong:** `ci-monitor.service.ts` has `const autoFixEnabled = false;` hardcoded, making its auto-fix path dead code. It still runs CI status polling though.
**Why it happens:** The ratchet service superseded the CI monitor for auto-fix, but the CI monitor still serves notification functions.
**How to avoid:** Move it as-is. Do not remove "dead" code during consolidation. The deprecation/removal is a separate concern.
**Warning signs:** N/A -- just be aware this is legacy code.

### Pitfall 4: Fixer Session Imports `SessionManager` from Claude Layer
**What goes wrong:** `fixer-session.service.ts` imports `SessionManager` from `'../claude/session'` (which is already a shim to the session domain).
**Why it happens:** It uses `SessionManager.getProjectPath(worktreePath)` to resolve Claude project paths.
**How to avoid:** After moving, update the import to use the absolute shim path: `@/backend/claude/session` or `@/backend/domains/session/claude/session`. Since this is a cross-domain dependency, use the absolute path.
**Warning signs:** TypeScript "Cannot find module" on the `SessionManager` import.

### Pitfall 5: `ratchetService` Singleton Used in `server.ts` and `app-context.ts`
**What goes wrong:** The ratchet service singleton is imported in `server.ts` (start/stop lifecycle) and `app-context.ts` (service registry). The shim must re-export the singleton.
**Why it happens:** The server lifecycle directly calls `ratchetService.start()` and `ratchetService.stop()`.
**How to avoid:** Ensure the shim at `src/backend/services/ratchet.service.ts` re-exports the singleton AND all exported types. Verify `app-context.ts` and `server.ts` still compile.
**Warning signs:** TypeScript errors in `server.ts` or `app-context.ts` about missing exports.

### Pitfall 6: `reconciliationService` Is Also Called From `server.ts`
**What goes wrong:** `server.ts` directly imports `reconciliationService` and calls `reconcile()`, `cleanupOrphans()`, `startPeriodicCleanup()`, and `stopPeriodicCleanup()`.
**Why it happens:** Reconciliation is part of server startup/shutdown lifecycle.
**How to avoid:** The shim at `src/backend/services/reconciliation.service.ts` must re-export the singleton. Verify `server.ts` still compiles after the move.
**Warning signs:** TypeScript errors in `server.ts` about missing `reconciliationService`.

### Pitfall 7: Test File for `reconciliation.service.test.ts` Mocks Prisma Directly
**What goes wrong:** Unlike other ratchet tests which mock through accessor modules, `reconciliation.service.test.ts` mocks `../db` (Prisma) directly and also imports `workspaceAccessor` from `../resource_accessors/index`.
**Why it happens:** The reconciliation test covers both the service and the accessor query patterns.
**How to avoid:** When moving this test, update mock paths: `../db` becomes `@/backend/db`, `../resource_accessors/index` becomes `@/backend/resource_accessors/index`, `../trpc/workspace/init.trpc` becomes `@/backend/trpc/workspace/init.trpc`.
**Warning signs:** Mock paths resolve incorrectly, causing tests to use real Prisma client or fail with module resolution errors.

## Code Examples

### Shim File Pattern (verified from Phases 2-3)
```typescript
// src/backend/services/ratchet.service.ts (becomes shim)
/**
 * @deprecated Import from '@/backend/domains/ratchet' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export { ratchetService } from '@/backend/domains/ratchet/ratchet.service';
export type {
  RatchetAction,
  RatchetCheckResult,
  WorkspaceRatchetResult,
} from '@/backend/domains/ratchet/ratchet.service';
```

### Test Mock Path Update Pattern
```typescript
// Before (test at src/backend/services/ratchet.service.test.ts):
vi.mock('../resource_accessors/workspace.accessor', () => ({...}));
vi.mock('./fixer-session.service', () => ({...}));

// After (test at src/backend/domains/ratchet/ratchet.service.test.ts):
vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({...}));
vi.mock('./fixer-session.service', () => ({...}));  // still relative if co-located
```

### Barrel Index Pattern
```typescript
// src/backend/domains/ratchet/index.ts
// Domain: ratchet
// Public API for the ratchet domain module.
// Consumers should import from '@/backend/domains/ratchet' only.

// Core ratchet polling and dispatch
export { ratchetService } from './ratchet.service';
export type { RatchetAction, RatchetCheckResult, WorkspaceRatchetResult } from './ratchet.service';

// CI fixer
export { ciFixerService } from './ci-fixer.service';
export type { CIFailureDetails, CIFixResult } from './ci-fixer.service';

// CI monitor (legacy, deprecated in favor of ratchet service)
export { ciMonitorService } from './ci-monitor.service';

// Shared fixer session acquisition
export { fixerSessionService } from './fixer-session.service';
export type {
  AcquireAndDispatchInput,
  AcquireAndDispatchResult,
  RunningIdleSessionAction,
} from './fixer-session.service';

// Reconciliation (workspace/session cleanup)
export { reconciliationService } from './reconciliation.service';
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| All services in flat `src/backend/services/` | Domain modules under `src/backend/domains/` | Phase 1 (foundation) | Services grouped by business concept |
| Direct imports between services | Cross-domain via absolute paths, intra-domain via relative | Phase 2-3 | Clear dependency boundaries |
| Module-level singletons | Instance-based singletons exported from domain barrels | Phase 2-3 | Same pattern, just relocated |
| CI monitor for auto-fix dispatch | Ratchet service for auto-fix dispatch | Pre-existing | `ci-monitor.service.ts` auto-fix path is dead code (`autoFixEnabled = false`) |

**Deprecated/outdated:**
- `ci-monitor.service.ts`: Auto-fix functionality superseded by ratchet service. The CI monitoring/notification part still runs. Move as-is; deprecation/removal is a future concern.

## Dependency Map (Move Order)

Services must be moved in dependency order to avoid breaking intra-domain imports:

1. **`fixer-session.service.ts`** (no intra-ratchet deps) -- depended on by ratchet.service and ci-fixer.service
2. **`ci-fixer.service.ts`** (depends on fixer-session) -- depended on by ci-monitor.service
3. **`ci-monitor.service.ts`** (depends on ci-fixer)
4. **`ratchet.service.ts`** (depends on fixer-session)
5. **`reconciliation.service.ts`** (independent of other ratchet services)

**Recommended execution order:** Move fixer-session first, then ci-fixer + ci-monitor + ratchet in any order, then reconciliation. Or move all at once (since shims provide compatibility during the transition).

**Simplest approach:** Move all five files at once and update all internal imports simultaneously. This is feasible because:
- All five files will use relative imports within the domain
- All external consumers use shims at old paths
- No intermediate state needs to compile

## Consumer Inventory

Files that import from the five services being consolidated:

| Service File | External Consumers (need shims) |
|---|---|
| `ratchet.service.ts` | `app-context.ts`, `server.ts`, `trpc/workspace.trpc.ts` |
| `ci-fixer.service.ts` | None external (only ci-monitor.service.ts, which moves too) |
| `ci-monitor.service.ts` | None external (standalone, not imported anywhere else) |
| `fixer-session.service.ts` | None external (only ratchet.service.ts and ci-fixer.service.ts, which move too) |
| `reconciliation.service.ts` | `server.ts`, `services/index.ts` |

**Key insight:** Only `ratchet.service.ts` and `reconciliation.service.ts` have external consumers that need shims. The other three files (`ci-fixer`, `ci-monitor`, `fixer-session`) are only consumed by services within the ratchet domain itself. However, they are also exported from `services/index.ts` barrel, so shims should still be created for backward compatibility.

## Open Questions

1. **Should `ci-monitor.service.ts` be included?**
   - What we know: It has no external consumers (not imported anywhere except its own file). It has `autoFixEnabled = false` hardcoded. It IS listed in the ROADMAP as a Phase 5 source file.
   - What's unclear: Whether it's actually still started/used anywhere.
   - Recommendation: Move it per the ROADMAP. It's listed explicitly. Even if unused, it belongs conceptually with the ratchet domain.

2. **Should `pr-review-fixer.service.ts` and `pr-review-monitor.service.ts` be included?**
   - What we know: RATCH-02 says "CI fixer, CI monitor, and PR review fixer consolidated under ratchet domain." However, the ROADMAP Phase 5 source file list does NOT include these two services. The ROADMAP Phase 4 (GitHub) lists `pr-review-monitor.service.ts` and `pr-review-fixer.service.ts` as GitHub domain files.
   - What's unclear: Whether RATCH-02's text is authoritative or the ROADMAP's source file list is authoritative.
   - Recommendation: Follow the ROADMAP source file list (5 files). The PR review fixer/monitor are listed under Phase 4 (GitHub domain). If Phase 4 has not run yet, those files stay in `services/` for now.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all 5 source files and their tests
- Existing domain patterns from `src/backend/domains/session/` and `src/backend/domains/workspace/`
- Shim patterns from Phase 2-3 completions (verified in 26 existing shim files)
- `.planning/ROADMAP.md` Phase 5 specification
- `.planning/REQUIREMENTS.md` RATCH-01, RATCH-02, RATCH-03

### Secondary (MEDIUM confidence)
- `.planning/phases/02-session-domain-consolidation/02-RESEARCH.md` for phase research noting fixer-session belongs in Phase 5

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, just reorganization of existing code
- Architecture: HIGH -- pattern is well-established from Phases 2-3 with 26+ shim files as precedent
- Pitfalls: HIGH -- identified through direct analysis of import graphs and test mock patterns
- Consumer inventory: HIGH -- verified via grep across entire `src/backend/` directory

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable -- no external dependency changes expected)
