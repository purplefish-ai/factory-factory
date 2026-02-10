# Phase 4: GitHub Domain Consolidation - Research

**Researched:** 2026-02-10
**Domain:** Internal codebase refactoring -- consolidate GitHub CLI services into `src/backend/domains/github/`
**Confidence:** HIGH

## Summary

Phase 4 consolidates four GitHub-related service files (`github-cli.service.ts`, `pr-snapshot.service.ts`, `pr-review-monitor.service.ts`, `pr-review-fixer.service.ts`) from `src/backend/services/` into `src/backend/domains/github/`. This follows the move-and-shim pattern established in Phases 2 (Session) and 3 (Workspace). The existing `src/backend/domains/github/` directory already exists with a placeholder `index.ts` awaiting population.

The GitHub CLI service is the largest file (1289 lines) and is the foundation: it wraps all `gh` CLI interactions with Zod-validated JSON parsing. The other three services layer on top: PR snapshot manages workspace PR state persistence, PR review monitor polls for new review comments, and PR review fixer creates auto-fix sessions. Key discovery: `prReviewMonitorService` is a dead-end singleton -- it is never imported by any other file, so its shim will have no consumers initially.

**Primary recommendation:** Follow the exact move-and-shim pattern from Phases 2-3. Split github-cli.service.ts into logical sub-modules (cli/, schemas/) within the domain, move the other services as-is, create shims at old paths, and add a barrel export with co-located domain export tests.

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | (project dep) | Validate gh CLI JSON responses | Already used extensively in github-cli.service.ts |
| p-limit | (project dep) | Concurrency limiting for GitHub API calls | Used in pr-review-monitor.service.ts |
| vitest | (project dep) | Unit testing framework | Project standard |

### Supporting (already in project)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @prisma-gen/client | generated | CIStatus, PRState, SessionStatus enums | Type imports for PR state computation |

### No new dependencies needed
This phase is purely internal refactoring. No new libraries are required.

## Architecture Patterns

### Recommended Domain Structure

```
src/backend/domains/github/
  index.ts                          # Barrel: selective named exports
  github-cli.service.ts             # Core CLI wrapper (exec gh, parse JSON)
  github-cli.schemas.ts             # Zod schemas (extracted from cli service)
  github-cli.normalizers.ts         # Status/review/check normalizers + mappers
  github-cli.types.ts               # Exported interfaces (PRInfo, PRStatusFromGitHub, etc.)
  pr-snapshot.service.ts            # PR snapshot persistence logic
  pr-review-monitor.service.ts      # Polling loop for review comments
  pr-review-fixer.service.ts        # Review fix session management
  github-domain-exports.test.ts     # Barrel export smoke test
  github-cli.service.test.ts        # Moved from services/ (updated imports)
  pr-snapshot.service.test.ts       # Moved from services/ (updated imports)
```

**Alternative (simpler):** Keep `github-cli.service.ts` as one large file rather than splitting into schemas/normalizers/types. The session domain kept `session-domain.service.ts` as a single 358-line file. The github-cli file is 1289 lines, so splitting is recommended but optional.

### Pattern 1: Move-and-Shim (Established)
**What:** Copy service to domain directory, update internal imports to relative paths, leave re-export shim at old path with `@deprecated` annotation.
**When to use:** Every file being consolidated in this phase.
**Example (from Phase 3):**
```typescript
// src/backend/services/workspace-activity.service.ts (shim)
/**
 * @deprecated Import from '@/backend/domains/workspace' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export { workspaceActivityService } from '@/backend/domains/workspace/lifecycle/activity.service';
```

### Pattern 2: Selective Barrel Exports (Established)
**What:** Named exports per module in index.ts. No blanket `export *`.
**When to use:** The domain's `index.ts` barrel file.
**Example (from workspace domain):**
```typescript
// src/backend/domains/workspace/index.ts
export { workspaceActivityService } from './lifecycle/activity.service';
export {
  type WorkspaceCreationDependencies,
  type WorkspaceCreationResult,
  WorkspaceCreationService,
  type WorkspaceCreationSource,
} from './lifecycle/creation.service';
```

### Pattern 3: Intra-Domain Relative Imports
**What:** Within the domain directory, use `./` relative imports. Cross-domain uses `@/` absolute paths.
**When to use:** All imports within `src/backend/domains/github/`.
**Example:**
```typescript
// src/backend/domains/github/pr-snapshot.service.ts
import { githubCLIService } from './github-cli.service';  // intra-domain: relative
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor'; // cross-domain: absolute
```

### Pattern 4: Domain Export Smoke Test (Established)
**What:** A test file that imports every public export from the barrel and asserts they are defined (not `undefined` due to circular deps).
**When to use:** Every domain barrel.
**Example (from session domain):**
```typescript
// github-domain-exports.test.ts
import { describe, expect, it } from 'vitest';
import {
  githubCLIService,
  prSnapshotService,
  // ... all public exports
} from './index';

describe('GitHub domain exports', () => {
  it('exports githubCLIService as an object', () => {
    expect(githubCLIService).toBeDefined();
  });
  // ...
});
```

### Pattern 5: Shim Uses Direct Module Path (Not Barrel)
**What:** Re-export shims import from the specific module file, not from the domain barrel, to avoid circular dependency risks.
**When to use:** All shims at old paths.
**Example:**
```typescript
// src/backend/services/github-cli.service.ts (shim)
/**
 * @deprecated Import from '@/backend/domains/github' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  type GitHubCLIHealthStatus,
  type PRInfo,
  type PRStatusFromGitHub,
  type ReviewRequestedPR,
  type GitHubCLIErrorType,
  type GitHubIssue,
  githubCLIService,
} from '@/backend/domains/github/github-cli.service';
// NOT: from '@/backend/domains/github' (barrel)
```

### Anti-Patterns to Avoid
- **Blanket `export *` in barrel:** Breaks tree-shaking and hides circular dependency issues. Use named exports per module.
- **Importing domain internals via barrel in shims:** Creates circular dependency risk. Shims must use direct module paths.
- **Module-level Map/globals (DOM-04):** The `PRReviewFixerService.pendingFixes` is a `Map<string, Promise>` as a private instance field -- this is correct per DOM-04. No module-level Maps exist in these files.
- **Moving tests without updating mock paths:** Tests mock using relative paths like `./github-cli.service` which must be updated to match new location.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import path resolution | Manual grep/replace across codebase | Shim at old path | Move-and-shim preserves all existing consumers without churn |
| Circular dependency detection | Manual analysis | Domain barrel export smoke tests | Catches `undefined` exports at test time |
| Type export forwarding | Re-declare types | `export type { X } from './path'` in shims | TypeScript handles re-exported types correctly |

**Key insight:** The move-and-shim pattern means this phase requires zero changes to consumer files. All existing imports continue to work through shims. Consumer rewiring happens in Phase 9.

## Common Pitfalls

### Pitfall 1: Forgetting to Export Types in Shims
**What goes wrong:** Consumer code that does `import type { PRInfo } from '@/backend/services/github-cli.service'` breaks at typecheck time if the shim only re-exports the service singleton.
**Why it happens:** `github-cli.service.ts` exports many types (`GitHubCLIErrorType`, `PRStatusFromGitHub`, `PRInfo`, `ReviewRequestedPR`, `GitHubCLIHealthStatus`, `GitHubIssue`) plus the singleton. Easy to miss some in the shim.
**How to avoid:** Grep for all exports from the original file. Ensure every exported name appears in the shim re-export.
**Warning signs:** `pnpm typecheck` fails on consumer files.

### Pitfall 2: Relative Import Paths in Moved Test Files
**What goes wrong:** Tests mock modules using relative paths like `vi.mock('./github-cli.service')`. When the test moves to a new directory, the relative path is wrong and the mock doesn't apply, causing real side effects (actual `execFile` calls).
**Why it happens:** Vitest mock paths are relative to the test file location.
**How to avoid:** Update ALL `vi.mock()` paths in moved test files to reflect the new directory structure. For tests that mock sibling files within the domain, use `./` relative paths.
**Warning signs:** Tests suddenly making real network calls or spawning processes.

### Pitfall 3: pr-snapshot.service.ts Has Cross-Domain Dependencies
**What goes wrong:** `pr-snapshot.service.ts` imports from `workspaceAccessor` and `kanbanStateService`, which are in different domains. Moving it into the github domain could create incorrect coupling.
**Why it happens:** PR snapshot service sits at the boundary between github and workspace domains.
**How to avoid:** Keep the cross-domain imports using `@/` absolute paths. `pr-snapshot.service.ts` importing `@/backend/resource_accessors/workspace.accessor` and `@/backend/services/kanban-state.service` (which is itself a shim to workspace domain) is the correct pattern -- cross-domain dependencies use absolute imports.
**Warning signs:** Circular import errors at runtime.

### Pitfall 4: pr-review-fixer.service.ts Depends on Session Domain
**What goes wrong:** `pr-review-fixer.service.ts` imports `fixerSessionService` and `sessionService` from the session domain. This is a cross-domain dependency.
**Why it happens:** The review fixer creates Claude sessions (session domain) to address review comments.
**How to avoid:** Keep using absolute `@/` imports for session domain dependencies. This is expected cross-domain coupling.
**Warning signs:** Circular dependency between github and session domains at module resolution.

### Pitfall 5: services/index.ts Barrel Must Be Updated
**What goes wrong:** `src/backend/services/index.ts` re-exports from the original service files. After creating shims, these re-exports should point to shims (which point to domain) to maintain consistency.
**Why it happens:** The services barrel is a separate layer from the individual shims.
**How to avoid:** Update services/index.ts to import from the shim paths (which already re-export from domain). Actually, since shims replace the original files in-place, the barrel's imports continue working automatically. No change needed to services/index.ts.
**Warning signs:** None -- this is a non-issue if shims replace originals at the same path.

### Pitfall 6: app-context.ts Imports github-cli.service Directly
**What goes wrong:** `app-context.ts` imports `githubCLIService` directly from `./services/github-cli.service`. This import will go through the shim automatically.
**Why it happens:** App context wires up DI container.
**How to avoid:** No action needed -- the shim pattern handles this transparently.
**Warning signs:** None if shim is correct.

### Pitfall 7: Dead-End Service (pr-review-monitor)
**What goes wrong:** Creating a shim for `pr-review-monitor.service.ts` even though it has zero external importers is wasted effort.
**Why it happens:** The service is only self-referenced (singleton export) and never imported anywhere.
**How to avoid:** Still create the shim for consistency with the pattern, but note in planning that this service is unused externally. The monitor's `start()` and `stop()` are not called from anywhere discoverable in the codebase -- it may be dead code or started from a lifecycle hook not found via import tracing.
**Warning signs:** N/A -- no consumers to break.

## Code Examples

Verified patterns from the codebase:

### Shim File Pattern (from Phase 3)
```typescript
// src/backend/services/github-cli.service.ts (becomes a shim)
/**
 * @deprecated Import from '@/backend/domains/github' instead.
 * This re-export shim will be removed in Phase 9 (Import Rewiring).
 */
export {
  type GitHubCLIErrorType,
  type GitHubCLIHealthStatus,
  type GitHubIssue,
  type PRInfo,
  type PRStatusFromGitHub,
  type ReviewRequestedPR,
  githubCLIService,
} from '@/backend/domains/github/github-cli.service';
```

### Barrel Index Pattern (from workspace domain)
```typescript
// src/backend/domains/github/index.ts
// Domain: github
// Public API for the github domain module.
// Consumers should import from '@/backend/domains/github' only.

// --- CLI interactions ---
export {
  type GitHubCLIErrorType,
  type GitHubCLIHealthStatus,
  type GitHubIssue,
  type PRInfo,
  type PRStatusFromGitHub,
  type ReviewRequestedPR,
  githubCLIService,
} from './github-cli.service';

// --- PR snapshot ---
export {
  type AttachAndRefreshResult,
  type PRSnapshotRefreshResult,
  prSnapshotService,
} from './pr-snapshot.service';

// --- PR review fixer ---
export {
  type PRReviewFixResult,
  type ReviewCommentDetails,
  prReviewFixerService,
} from './pr-review-fixer.service';

// --- PR review monitor ---
export { prReviewMonitorService } from './pr-review-monitor.service';
```

### Moved Service with Updated Imports
```typescript
// src/backend/domains/github/pr-snapshot.service.ts
// (moved from src/backend/services/pr-snapshot.service.ts)
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor'; // cross-domain: absolute
import { githubCLIService } from './github-cli.service';  // intra-domain: relative
import { kanbanStateService } from '@/backend/services/kanban-state.service'; // cross-domain: absolute (shim to workspace domain)
import { createLogger } from '@/backend/services/logger.service'; // shared infrastructure: absolute
```

### Test File with Updated Mocks
```typescript
// src/backend/domains/github/pr-snapshot.service.test.ts
vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock('./github-cli.service', () => ({  // relative: same domain
  githubCLIService: {
    fetchAndComputePRState: (...args: unknown[]) => mockFetchAndComputePRState(...args),
  },
}));

vi.mock('@/backend/services/kanban-state.service', () => ({  // absolute: cross-domain
  kanbanStateService: {
    updateCachedKanbanColumn: (...args: unknown[]) => mockUpdateCachedKanbanColumn(...args),
  },
}));
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Flat services/ directory | Domain-organized modules | Phases 2-3 | Better cohesion, clearer ownership |
| Module-level singletons only | Instance fields on class singletons (DOM-04) | Phase 2 | No module-level Maps/globals |
| Direct imports everywhere | Shim at old path, direct import to domain | Phase 2 | Zero consumer changes during consolidation |

**Already correct (no changes needed):**
- `PRReviewFixerService.pendingFixes` is already an instance-level `Map` (DOM-04 compliant)
- `PRReviewMonitorService` state (`isShuttingDown`, `monitorLoop`, `checkLimit`, `backoff`) is already instance-level

## Dependency Map

### Files to Move and Their Dependencies

#### `github-cli.service.ts` (1289 lines)
- **Imports from:** `node:child_process`, `node:util`, `@prisma-gen/client`, `zod`, `@/shared/github-types`, `./logger.service`, `./rate-limit-backoff`
- **Consumed by (direct import):** `pr-snapshot.service.ts`, `pr-review-monitor.service.ts`, `ci-monitor.service.ts`, `ratchet.service.ts`, `scheduler.service.ts`, `cli-health.service.ts`, `app-context.ts`, `github.trpc.ts`, `pr-review.trpc.ts`, `workspace-query.service.ts`, `worktree-lifecycle.service.ts`
- **Exported names:** `githubCLIService`, `GitHubCLIErrorType`, `PRStatusFromGitHub`, `PRInfo`, `ReviewRequestedPR`, `GitHubCLIHealthStatus`, `GitHubIssue`

#### `pr-snapshot.service.ts` (165 lines)
- **Imports from:** `./github-cli.service`, `../resource_accessors/workspace.accessor`, `./kanban-state.service`, `./logger.service`
- **Consumed by (direct import):** `scheduler.service.ts`, `pr-detection.interceptor.ts`, `workspace-query.service.ts`, `services/index.ts`
- **Exported names:** `prSnapshotService`, `PRSnapshotRefreshResult`, `AttachAndRefreshResult`

#### `pr-review-monitor.service.ts` (334 lines)
- **Imports from:** `p-limit`, `../resource_accessors/workspace.accessor`, `./constants`, `./github-cli.service`, `./logger.service`, `./pr-review-fixer.service`, `./rate-limit-backoff`
- **Consumed by:** NOBODY (dead-end -- not imported anywhere)
- **Exported names:** `prReviewMonitorService`

#### `pr-review-fixer.service.ts` (244 lines)
- **Imports from:** `@prisma-gen/client`, `./fixer-session.service`, `./logger.service`, `./session.service`
- **Consumed by (direct import):** `pr-review-monitor.service.ts`, `services/index.ts`
- **Exported names:** `prReviewFixerService`, `ReviewCommentDetails`, `PRReviewFixResult`

### Cross-Domain Dependencies After Move
| From (github domain) | To (external) | Import Path |
|----------------------|----------------|-------------|
| github-cli.service | logger.service | `@/backend/services/logger.service` |
| github-cli.service | rate-limit-backoff | `@/backend/services/rate-limit-backoff` |
| github-cli.service | @/shared/github-types | `@/shared/github-types` |
| pr-snapshot.service | workspace.accessor | `@/backend/resource_accessors/workspace.accessor` |
| pr-snapshot.service | kanban-state.service | `@/backend/services/kanban-state.service` |
| pr-review-monitor.service | workspace.accessor | `@/backend/resource_accessors/workspace.accessor` |
| pr-review-monitor.service | constants | `@/backend/services/constants` |
| pr-review-monitor.service | rate-limit-backoff | `@/backend/services/rate-limit-backoff` |
| pr-review-fixer.service | fixer-session.service | `@/backend/services/fixer-session.service` |
| pr-review-fixer.service | session.service | `@/backend/services/session.service` |

## Open Questions

1. **Should github-cli.service.ts be split into sub-modules?**
   - What we know: It is 1289 lines with clearly separable concerns: Zod schemas (~130 lines), normalizer functions (~100 lines), type exports (~50 lines), and the service class (~1000 lines).
   - What's unclear: Whether splitting adds value or just creates more files to manage.
   - Recommendation: Keep as single file for Phase 4 consistency with the "move first, refactor later" principle. Splitting can be a follow-up if desired. The session domain kept its 358-line service as one file.

2. **Is pr-review-monitor.service.ts dead code?**
   - What we know: It is never imported by any file. Its `start()`/`stop()` are never called. The service itself marks auto-fix as disabled ("Legacy: This service is deprecated in favor of ratchet").
   - What's unclear: Whether it should be moved at all or simply deleted.
   - Recommendation: Move it for completeness (the phase spec lists it). Note the dead-code status in the plan so the implementer can flag it. Deletion is a separate decision.

3. **Should pr-snapshot.service.ts live in github or workspace domain?**
   - What we know: It bridges both -- it calls `githubCLIService` (github domain) and writes to `workspaceAccessor`/`kanbanStateService` (workspace domain). It currently lives in services/ as a cross-cutting concern.
   - What's unclear: Which domain "owns" it conceptually.
   - Recommendation: Move to github domain as specified in the phase description. The cross-domain imports to workspace are acceptable -- this is the same pattern used throughout (e.g., session domain services importing workspace accessors). The PR snapshot is fundamentally a GitHub-data-fetch operation that happens to persist to workspace.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all four source files
- Direct codebase analysis of all consumer files (grep for all import paths)
- Direct codebase analysis of Phase 2-3 established patterns (session/workspace domains, shims)
- `src/backend/services/index.ts` -- services barrel
- `src/backend/app-context.ts` -- DI wiring
- `src/backend/domains/session/index.ts` and `src/backend/domains/workspace/index.ts` -- barrel patterns
- `src/backend/domains/session/session-domain-exports.test.ts` and `src/backend/domains/workspace/workspace-domain-exports.test.ts` -- export smoke test patterns
- Existing shim files (e.g., `workspace-activity.service.ts`, `kanban-state.service.ts`) -- shim patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies, purely internal refactoring
- Architecture: HIGH - Follows patterns directly established by Phases 2-3 in same codebase
- Pitfalls: HIGH - Identified through direct analysis of import graphs and code structure
- Dependency map: HIGH - Comprehensive grep of all imports/consumers

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable -- internal refactoring patterns, not external dependency)
