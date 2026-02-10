# Phase 9: AppContext & Import Rewiring - Research

**Researched:** 2026-02-10
**Domain:** TypeScript import path migration and DI context refactoring
**Confidence:** HIGH

## Summary

Phase 9 is the culmination of the SRP refactor (Phases 1-8). All 6 domains are consolidated with barrel files, all cross-domain imports are eliminated via bridge injection, and dependency-cruiser validates clean (367 modules, 1243 dependencies, 0 violations). The remaining work is mechanical: update import paths throughout the non-domain codebase to point at domain barrel files instead of deprecated shim files, then delete the shims.

The codebase has **38 shim files** in `src/backend/services/` and **12 shim files** in `src/backend/claude/` (including the `claude/index.ts` barrel shim). These shims currently re-export from domain modules and are marked `@deprecated`. Consumers fall into 5 categories: (1) `app-context.ts` -- 20 imports from services shims, (2) tRPC routers -- ~25 imports across 9 files, (3) WebSocket handlers -- ~5 imports across 3 files, (4) interceptors/prompts/agents -- ~12 imports across 6 files, (5) domain-internal imports of infrastructure services (logger, config, constants, etc.) -- ~60 imports that are legitimate and should NOT be changed. Additionally, there are ~15 imports from `src/backend/claude/` shims across external consumers.

The key distinction the planner must honor: **infrastructure services stay in `src/backend/services/`** and those imports are correct. Only imports that go through deprecated shims need rewiring. The `services/index.ts` barrel itself needs updating to remove domain re-exports and only export infrastructure services.

**Primary recommendation:** Work in 4 waves -- (1) rewire `app-context.ts`, (2) rewire tRPC routers + WebSocket handlers + interceptors, (3) rewire remaining external consumers (agents, prompts, utils), (4) delete all shim files and update `services/index.ts`. Run `pnpm typecheck` after each wave. Run dependency-cruiser at the end.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | Type system, import path resolution | Already configured |
| dependency-cruiser | 17.3.7 | Validates no circular imports, no cross-domain imports | Already configured with 12 rules |
| Biome | 2.3.13 | Formatting after rewiring | Already configured |
| Vitest | 4.0.18 | Test runner to validate nothing breaks | Already configured |

### Supporting

No new libraries needed. This is a pure import-path refactoring phase.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual import rewiring | ts-morph automated codemod | Not worth the setup for ~80 import changes; manual is more precise and less risky |
| Delete shims immediately | Deprecation warnings only | Phase 9 IS the deletion step; deprecation was phases 2-8 |
| Barrel-only imports | Deep path imports into domains | Barrel-only is the established convention; all domain barrels already export everything needed |

## Architecture Patterns

### Target Import Structure After Phase 9

```
src/backend/
  app-context.ts          # Imports from @/backend/domains/{name} barrels + infra services
  trpc/                   # Imports from @/backend/domains/{name} barrels + infra services
  routers/websocket/      # Imports from @/backend/domains/{name} barrels + infra services
  interceptors/           # Imports from @/backend/domains/{name} barrels + infra services
  services/               # ONLY infrastructure services remain (no shims)
    config.service.ts
    logger.service.ts
    scheduler.service.ts
    port.service.ts
    port-allocation.service.ts
    server-instance.service.ts
    rate-limiter.service.ts
    health.service.ts
    cli-health.service.ts
    notification.service.ts
    file-lock.service.ts
    data-backup.service.ts
    factory-config.service.ts
    user-settings-query.service.ts
    decision-log-query.service.ts
    project-management.service.ts
    slash-command-cache.service.ts
    constants.ts
    rate-limit-backoff.ts
    git-ops.service.ts
    index.ts              # Updated to export only infrastructure services
  claude/                 # DELETED (was shim directory)
  domains/
    session/index.ts      # Barrel: chatConnectionService, sessionService, etc.
    workspace/index.ts    # Barrel: workspaceStateMachine, kanbanStateService, etc.
    github/index.ts       # Barrel: githubCLIService, prSnapshotService, etc.
    ratchet/index.ts      # Barrel: ratchetService, reconciliationService, etc.
    terminal/index.ts     # Barrel: terminalService
    run-script/index.ts   # Barrel: runScriptService, startupScriptService, etc.
  orchestration/          # Already imports from domain barrels (Phase 8)
```

### Pattern 1: Import Rewiring From Shim to Domain Barrel

**What:** Replace shim import with domain barrel import.
**When to use:** Every import from a deprecated shim file.

```typescript
// BEFORE (importing through shim):
import { sessionService } from '../services/session.service';
import { workspaceStateMachine } from '../services/workspace-state-machine.service';

// AFTER (importing from domain barrel):
import { sessionService } from '@/backend/domains/session';
import { workspaceStateMachine } from '@/backend/domains/workspace';
```

### Pattern 2: AppContext Import Restructuring

**What:** Group app-context imports by source (domains vs infrastructure).
**When to use:** For `app-context.ts` specifically.

```typescript
// BEFORE:
import { chatConnectionService } from './services/chat-connection.service';
import { configService } from './services/config.service';
// ... 20 lines of mixed domain/infra imports

// AFTER:
// Domain imports (from barrel files)
import {
  chatConnectionService,
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDomainService,
  sessionService,
  type SessionFileLogger,
  sessionFileLogger,
} from './domains/session';
import { githubCLIService } from './domains/github';
import { kanbanStateService, workspaceStateMachine } from './domains/workspace';
import { ratchetService } from './domains/ratchet';
import { terminalService } from './domains/terminal';
import {
  type RunScriptService,
  runScriptService,
  runScriptStateMachine,
  startupScriptService,
} from './domains/run-script';

// Infrastructure imports (stay in services/)
import { cliHealthService } from './services/cli-health.service';
import { configService } from './services/config.service';
import { createLogger } from './services/logger.service';
import { findAvailablePort } from './services/port.service';
import { rateLimiter } from './services/rate-limiter.service';
import { schedulerService } from './services/scheduler.service';
import { serverInstanceService } from './services/server-instance.service';
```

### Pattern 3: Claude Shim Directory Elimination

**What:** Replace imports from `src/backend/claude/` with domain session barrel.
**When to use:** All external consumers of the claude shim.

```typescript
// BEFORE:
import { SessionManager } from '../claude/session';
import type { ClaudeClient } from '../claude/index';

// AFTER:
import { SessionManager } from '@/backend/domains/session';
import type { ClaudeClient } from '@/backend/domains/session';
```

### Pattern 4: Backward-Compatible Wrapper Migration (worktree-lifecycle)

**What:** The `worktree-lifecycle.service.ts` shim exports `setWorkspaceInitMode` and `getWorkspaceInitMode` as free functions that wrap `worktreeLifecycleService.setInitMode()` and `worktreeLifecycleService.getInitMode()`. The single consumer (`init.trpc.ts`) must be updated to call the service methods directly.
**When to use:** For `init.trpc.ts` specifically.

```typescript
// BEFORE (init.trpc.ts):
import { getWorkspaceInitMode, setWorkspaceInitMode } from '../../services/worktree-lifecycle.service';
// ...
const resumeMode = await getWorkspaceInitMode(workspace.id, workspace.project.worktreeBasePath);
await setWorkspaceInitMode(workspace.id, resumeMode, workspace.project.worktreeBasePath);

// AFTER:
import { worktreeLifecycleService } from '@/backend/domains/workspace';
// ...
const resumeMode = await worktreeLifecycleService.getInitMode(workspace.id, workspace.project.worktreeBasePath);
await worktreeLifecycleService.setInitMode(workspace.id, resumeMode, workspace.project.worktreeBasePath);
```

### Anti-Patterns to Avoid

- **Rewiring infrastructure imports:** Do NOT change imports of `logger.service`, `config.service`, `constants.ts`, `rate-limit-backoff.ts`, `factory-config.service`, `port-allocation.service`, `git-ops.service`, `slash-command-cache.service` etc. These are legitimate infrastructure services that stay in `src/backend/services/`.
- **Bypassing barrel files:** Do NOT import from domain internals (e.g., `@/backend/domains/session/lifecycle/session.service`). Always import from the domain barrel (`@/backend/domains/session`).
- **Domain-internal shim imports:** Domain files that import from `@/backend/services/` for infrastructure services (logger, config, constants) are CORRECT and should NOT be changed in this phase. Those are infrastructure dependencies, not shim dependencies.
- **Breaking the `services/index.ts` barrel too early:** The `services/index.ts` currently re-exports domain services. It must be updated AFTER all consumers are rewired, not before.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Finding all import consumers | Manual file-by-file search | `grep -r` with the patterns documented below | Complete list already catalogued in this research |
| Validating no circular deps | Manual inspection | `npx dependency-cruiser --config .dependency-cruiser.cjs src/backend --output-type err` | 12 rules already configured, catches all violations |
| Type validation | Manual testing | `pnpm typecheck` | TypeScript compiler catches all import resolution errors |
| Checking for unused shim exports | Manual analysis | Delete shim, run typecheck -- any error = missed consumer | Compiler is the source of truth |

**Key insight:** TypeScript's compiler IS the primary validation tool. After rewiring imports and deleting shims, `pnpm typecheck` will fail on any missed consumer. This means the planner can structure tasks as "rewire + delete + verify" with high confidence.

## Common Pitfalls

### Pitfall 1: Missing Type-Only Imports

**What goes wrong:** Some consumers import only types from shim files (e.g., `import type { ConnectionInfo } from '../../services/chat-connection.service'`). These are easy to miss because they don't cause runtime errors.
**Why it happens:** Type-only imports are erased at compile time, so even if the shim is deleted, the build may still succeed if the consuming file isn't type-checked.
**How to avoid:** Always run `pnpm typecheck` (not just `pnpm build`) after deleting shims. The WebSocket `chat.handler.ts` has two type re-exports at the bottom that need updating.
**Warning signs:** Files with `import type { ... }` from shim paths.

**Known type-only imports to watch:**
- `src/backend/routers/websocket/chat.handler.ts` line 313-314: `export type { ConnectionInfo } from '../../services/chat-connection.service'`
- `src/backend/trpc/workspace/init.trpc.ts`: `getWorkspaceInitMode`, `setWorkspaceInitMode` from worktree shim
- Multiple domain `.test.ts` files importing `configService` type

### Pitfall 2: The `services/index.ts` Barrel Has Domain Re-exports

**What goes wrong:** `src/backend/services/index.ts` currently re-exports domain services (sessionDomainService, chatConnectionService, workspaceActivityService, etc.). If you delete shim files but not the index barrel's references, you get compile errors.
**Why it happens:** The barrel was built to be a "one-stop shop" and includes both infrastructure and domain re-exports.
**How to avoid:** Update `services/index.ts` AFTER all external consumers are rewired. Remove all lines that re-export from domain shims. Keep only infrastructure service exports (dataBackupService, configService, createLogger, notificationService, etc.).
**Warning signs:** `admin.trpc.ts` imports `dataBackupService` from `'../services'` (barrel) -- this is an infrastructure service and should remain.

### Pitfall 3: The worktree-lifecycle Shim Has Wrapper Functions

**What goes wrong:** `worktree-lifecycle.service.ts` is not a pure re-export shim. It defines `setWorkspaceInitMode()` and `getWorkspaceInitMode()` as free-function wrappers around `worktreeLifecycleService.setInitMode()` and `worktreeLifecycleService.getInitMode()`. Deleting the shim without updating the consumer breaks the build.
**Why it happens:** The original API was free functions; the domain module uses instance methods.
**How to avoid:** Update `init.trpc.ts` to use `worktreeLifecycleService.setInitMode()` and `.getInitMode()` directly, then delete the shim.
**Warning signs:** Any shim file that has `export const` or `export function` rather than just `export { ... } from`.

### Pitfall 4: The claude/registry.ts Shim Has Wrapper Functions

**What goes wrong:** `claude/registry.ts` exports free functions (`registerProcess`, `unregisterProcess`, etc.) that wrap `processRegistry` methods. However, code analysis shows these free functions are NOT used by any external consumer -- all consumers use `processRegistry.methodName()` or import via the session domain barrel. The shim can be safely deleted.
**Why it happens:** The shim was created for backward compatibility but the migration already moved consumers to the OOP API.
**How to avoid:** Verify with `pnpm typecheck` after deletion.
**Warning signs:** None expected, but verify.

### Pitfall 5: Domain-Internal Imports From Services (NOT Phase 9 Scope)

**What goes wrong:** You might be tempted to also rewire domain-internal imports like `import { createLogger } from '@/backend/services/logger.service'` inside domain files. These are NOT shim imports -- they are legitimate infrastructure dependencies.
**Why it happens:** The grep results show ~60 domain files importing from `@/backend/services/` but these are infrastructure imports (logger, config, constants, rate-limit-backoff, factory-config, port-allocation, git-ops, slash-command-cache).
**How to avoid:** Only rewire imports that target SHIM files (files marked `@deprecated`). Domain files importing infrastructure services are correct.
**Warning signs:** If you're touching files inside `src/backend/domains/`, you're probably changing the wrong thing (except for the one case of `reconciliation.service.ts` importing `workspaceStateMachine` from a shim -- see below).

### Pitfall 6: One Domain File Imports Another Domain Through a Shim

**What goes wrong:** `src/backend/domains/ratchet/reconciliation.service.ts` imports `workspaceStateMachine` from `@/backend/services/workspace-state-machine.service` (a shim). This is technically a cross-domain import hiding behind a shim.
**Why it happens:** This was likely missed during the bridge injection phase (Phase 8).
**How to avoid:** This import should be converted to use a bridge, or the reconciliation service should import from the orchestration layer. Since the dependency-cruiser `no-cross-domain-imports` rule already passes (the shim masks it), deleting the shim will cause a NEW dependency-cruiser violation. This MUST be handled before the shim is deleted -- either add a bridge or move the import to use the domain barrel (which would then trigger the cross-domain rule).
**Warning signs:** `npx dependency-cruiser` fails after shim deletion.

### Pitfall 7: session-domain.service.test.ts and Other Tests Import Shims

**What goes wrong:** Some test files import from shim paths rather than domain barrels.
**Why it happens:** Tests were written before domain consolidation.
**How to avoid:** Include test files in the rewiring scope. Known files:
- `src/backend/domains/session/session-domain.service.test.ts` -- imports `chatConnectionService` from shim
- `src/backend/domains/ratchet/fixer-session.service.test.ts` -- imports `configService` from shim (infrastructure, OK to keep)
- `src/backend/domains/workspace/lifecycle/creation.service.test.ts` -- imports `gitOpsService`, `configService`, `createLogger` from shims (infrastructure, OK to keep)
- `src/backend/domains/session/store/session-queue.test.ts` -- imports `SERVICE_LIMITS` from constants (infrastructure, OK to keep)

### Pitfall 8: session-publisher.ts Inside Domain Imports Same-Domain Shims

**What goes wrong:** `src/backend/domains/session/store/session-publisher.ts` imports `chatConnectionService` and `sessionFileLogger` from `@/backend/services/` shims instead of using relative imports within its own domain.
**Why it happens:** The file was moved to the domain but its imports weren't fully updated.
**How to avoid:** These imports should become relative imports within the session domain (or use the session barrel). This is a domain-internal cleanup that should happen alongside the external rewiring.

## Code Examples

### Complete app-context.ts After Rewiring

```typescript
// Domain imports (from barrel files)
import {
  chatConnectionService,
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDomainService,
  type SessionFileLogger,
  sessionFileLogger,
  sessionService,
} from './domains/session';
import { githubCLIService } from './domains/github';
import { kanbanStateService, workspaceStateMachine } from './domains/workspace';
import { ratchetService } from './domains/ratchet';
import { terminalService } from './domains/terminal';
import {
  type RunScriptService,
  runScriptService,
  runScriptStateMachine,
  startupScriptService,
} from './domains/run-script';

// Infrastructure imports (stay in services/)
import { cliHealthService } from './services/cli-health.service';
import { configService } from './services/config.service';
import { createLogger } from './services/logger.service';
import { findAvailablePort } from './services/port.service';
import { rateLimiter } from './services/rate-limiter.service';
import { schedulerService } from './services/scheduler.service';
import { serverInstanceService } from './services/server-instance.service';

// ... rest of AppServices type and createServices function unchanged
```

### workspace.trpc.ts Import Rewiring

```typescript
// BEFORE:
import { ratchetService } from '../services/ratchet.service';
import { sessionService } from '../services/session.service';
import { WorkspaceCreationService } from '../services/workspace-creation.service';
import { workspaceDataService } from '../services/workspace-data.service';
import { deriveWorkspaceFlowStateFromWorkspace } from '../services/workspace-flow-state.service';
import { workspaceQueryService } from '../services/workspace-query.service';

// AFTER:
import { ratchetService } from '@/backend/domains/ratchet';
import { sessionService } from '@/backend/domains/session';
import {
  WorkspaceCreationService,
  workspaceDataService,
  deriveWorkspaceFlowStateFromWorkspace,
  workspaceQueryService,
} from '@/backend/domains/workspace';
```

### server.ts Import Rewiring

```typescript
// BEFORE:
import { reconciliationService } from './services/reconciliation.service';

// AFTER:
import { reconciliationService } from './domains/ratchet';
```

### Shim File Inventory (Files to Delete)

**services/ shims (38 files):**
- `chat-connection.service.ts` -> session domain
- `chat-event-forwarder.service.ts` -> session domain
- `chat-message-handlers.service.ts` -> session domain
- `session.service.ts` -> session domain
- `session-data.service.ts` -> session domain
- `session-domain.service.ts` -> session domain
- `session-file-logger.service.ts` -> session domain
- `workspace-activity.service.ts` -> workspace domain
- `workspace-creation.service.ts` -> workspace domain
- `workspace-data.service.ts` -> workspace domain
- `workspace-flow-state.service.ts` -> workspace domain
- `workspace-init-policy.service.ts` -> workspace domain
- `workspace-query.service.ts` -> workspace domain
- `workspace-state-machine.service.ts` -> workspace domain
- `worktree-lifecycle.service.ts` -> workspace domain (has wrapper functions)
- `kanban-state.service.ts` -> workspace domain
- `github-cli.service.ts` -> github domain
- `pr-review-fixer.service.ts` -> github domain
- `pr-review-monitor.service.ts` -> github domain
- `pr-snapshot.service.ts` -> github domain
- `ratchet.service.ts` -> ratchet domain
- `ci-fixer.service.ts` -> ratchet domain
- `ci-monitor.service.ts` -> ratchet domain
- `fixer-session.service.ts` -> ratchet domain
- `reconciliation.service.ts` -> ratchet domain
- `terminal.service.ts` -> terminal domain
- `run-script.service.ts` -> run-script domain
- `run-script-state-machine.service.ts` -> run-script domain
- `startup-script.service.ts` -> run-script domain
- `session-store/` directory (9 shim files) -> session domain store

**claude/ shims (12 files -- entire directory):**
- `index.ts`, `session.ts`, `process.ts`, `types.ts`, `registry.ts`, `protocol.ts`, `protocol-io.ts`, `permissions.ts`, `permission-coordinator.ts`, `monitoring.ts`, `constants.ts`, `types/process-types.ts`

**Services to keep (infrastructure):**
- `config.service.ts`, `logger.service.ts`, `scheduler.service.ts`
- `port.service.ts`, `port-allocation.service.ts`
- `server-instance.service.ts`, `rate-limiter.service.ts`
- `health.service.ts`, `cli-health.service.ts`
- `notification.service.ts`, `file-lock.service.ts`
- `data-backup.service.ts`, `factory-config.service.ts`
- `user-settings-query.service.ts`, `decision-log-query.service.ts`
- `project-management.service.ts`, `slash-command-cache.service.ts`
- `constants.ts`, `rate-limit-backoff.ts`, `git-ops.service.ts`
- `index.ts` (updated to only export infrastructure)
- Test files: `port.service.test.ts`, `data-backup.service.test.ts`, etc.

## Consumer Inventory (Files That Need Import Rewiring)

### Category 1: app-context.ts (1 file, ~20 imports)
- `src/backend/app-context.ts` -- 20 imports from shim services, 1 from domain

### Category 2: tRPC Routers (9 files, ~25 imports)
- `src/backend/trpc/workspace.trpc.ts` -- 6 shim imports
- `src/backend/trpc/session.trpc.ts` -- 3 shim imports (including claude/session)
- `src/backend/trpc/github.trpc.ts` -- 3 imports (1 shim: github-cli, 1 infra: project-management, 1 shim: workspace-data)
- `src/backend/trpc/admin.trpc.ts` -- 4 imports (1 barrel: services, 2 shim: session-data + workspace-data, 1 infra: decision-log-query)
- `src/backend/trpc/workspace/init.trpc.ts` -- 6 shim imports
- `src/backend/trpc/workspace/workspace-helpers.ts` -- 1 shim import (workspace-data)
- `src/backend/trpc/workspace/git.trpc.ts` -- 1 shim import (workspace-data)
- `src/backend/trpc/workspace/ide.trpc.ts` -- 2 imports (1 infra: user-settings-query, 1 shim: workspace-data)
- `src/backend/trpc/decision-log.trpc.ts` -- 1 infra import (decision-log-query, NO CHANGE)
- `src/backend/trpc/project.trpc.ts` -- 2 infra imports (factory-config, project-management, NO CHANGE)
- `src/backend/trpc/user-settings.trpc.ts` -- 1 infra import (user-settings-query, NO CHANGE)
- `src/backend/trpc/pr-review.trpc.ts` -- 0 shim imports (uses ctx.appContext.services, NO CHANGE)

### Category 3: WebSocket Handlers (3 files, ~5 imports)
- `src/backend/routers/websocket/chat.handler.ts` -- 2 shim imports + 2 type re-exports
- `src/backend/routers/websocket/terminal.handler.ts` -- 2 shim imports
- `src/backend/routers/mcp/terminal.mcp.ts` -- 2 shim imports

### Category 4: Interceptors + Prompts + Agents (6 files, ~12 imports)
- `src/backend/interceptors/pr-detection.interceptor.ts` -- 2 imports (1 infra: logger, 1 shim: pr-snapshot)
- `src/backend/interceptors/conversation-rename.interceptor.ts` -- 4 imports (2 infra: config+logger, 2 shim: session.service + claude/session)
- `src/backend/interceptors/branch-rename.interceptor.ts` -- 1 infra import (logger, NO CHANGE)
- `src/backend/interceptors/registry.ts` -- 1 infra import (logger, NO CHANGE)
- `src/backend/prompts/ratchet-dispatch.ts` -- 1 infra import (logger, NO CHANGE)
- `src/backend/prompts/workflows.ts` -- 1 infra import (logger, NO CHANGE)
- `src/backend/prompts/quick-actions.ts` -- 1 infra import (logger, NO CHANGE)
- `src/backend/agents/process-adapter.ts` -- 2 imports (1 infra: logger, 1 shim: claude/index)

### Category 5: server.ts (1 file, 1 import)
- `src/backend/server.ts` -- 1 shim import (reconciliation.service)

### Category 6: Other (utils, lib)
- `src/backend/utils/conversation-analyzer.ts` -- 1 shim import (claude/session type)
- `src/backend/utils/conversation-analyzer.test.ts` -- 1 shim import (claude/session type)
- `src/backend/lib/file-lock-mutex.ts` -- 1 infra import (logger, NO CHANGE)

### Category 7: Domain-internal self-references via shims (fix as part of cleanup)
- `src/backend/domains/session/store/session-publisher.ts` -- 2 imports from own domain via shim
- `src/backend/domains/session/session-domain.service.test.ts` -- 1 import via shim
- `src/backend/domains/ratchet/reconciliation.service.ts` -- 1 cross-domain import via shim (SPECIAL CASE)

## The reconciliation.service.ts Cross-Domain Issue

`src/backend/domains/ratchet/reconciliation.service.ts` line 10 imports `workspaceStateMachine` from `@/backend/services/workspace-state-machine.service` (a shim). This is a cross-domain import (ratchet -> workspace) hiding behind the shim. When the shim is deleted, two things happen:

1. The import breaks (no more shim to resolve through)
2. If rewired to `@/backend/domains/workspace`, the `no-cross-domain-imports` dependency-cruiser rule fires

**Resolution options (planner should pick one):**
- **Option A (Bridge injection):** Add a `RatchetWorkspaceBridge` interface with the needed workspace methods. Wire it in `domain-bridges.orchestrator.ts`. This follows the established pattern from Phase 8.
- **Option B (Move to orchestration):** If reconciliation is inherently cross-domain, it may belong in the orchestration layer.

Looking at the actual usage: `reconciliation.service.ts` calls `workspaceStateMachine.markFailed()` and `workspaceStateMachine.markReady()`. These are the same methods already bridged for `startupScriptService`. **Option A is cleanest** -- add workspace state transition methods to the existing ratchet bridge.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| All services in flat `services/` directory | Domain modules with barrels | Phases 1-7 | Code organized by business domain |
| Direct cross-domain imports | Bridge injection via `configure()` | Phase 8 | Domains are decoupled |
| Shim re-exports for backward compat | Import directly from domain barrels | Phase 9 (now) | Shims can be deleted |

**Deprecated/outdated:**
- `src/backend/services/` shim files: All 38 marked `@deprecated`, to be deleted in this phase
- `src/backend/claude/` shim directory: All 12 files marked `@deprecated`, entire directory to be deleted
- `src/backend/services/session-store/` shim directory: All 9 files marked `@deprecated`, entire directory to be deleted

## Open Questions

1. **Should `git-ops.service.ts` stay in services or move to workspace domain?**
   - What we know: It's used by workspace domain files (`creation.service.ts`, `workspace-query.service.ts`, `worktree-lifecycle.service.ts`) and orchestration (`workspace-init.orchestrator.ts`). It's NOT marked `@deprecated` and is not a shim.
   - What's unclear: Whether it's considered infrastructure or a workspace domain concern.
   - Recommendation: Leave it in `services/` for Phase 9. It's not blocking the shim deletion. Could be moved in a future cleanup phase.

2. **Should `services/index.ts` be deleted entirely or kept as infrastructure barrel?**
   - What we know: After shim removal, it would export ~8 infrastructure services. The only current barrel consumer is `admin.trpc.ts` importing `dataBackupService`.
   - What's unclear: Whether a barrel for infrastructure services adds value.
   - Recommendation: Keep it but trim to only infrastructure exports. Rename the comment to "Infrastructure Services Index" to be clear.

3. **Test files referencing shim paths inside domain directories**
   - What we know: Some domain test files import from `@/backend/services/` for infrastructure (config, logger). These are correct.
   - One test (`session-domain.service.test.ts`) imports `chatConnectionService` from a shim -- this should be a relative import.
   - Recommendation: Fix the one test file. Leave infrastructure imports alone.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all 50+ files involved
- `npx dependency-cruiser --config .dependency-cruiser.cjs src/backend --output-type err` -- 0 violations confirmed
- All shim files read and verified as `@deprecated` re-export shims
- All domain barrel files read and verified as complete public APIs
- All consumer files read and import paths catalogued

### Secondary (MEDIUM confidence)
- Pattern consistency with Phases 2-8 (same move-and-shim pattern, same bridge injection pattern)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries, pure refactoring
- Architecture: HIGH -- patterns established in Phases 1-8, all files inspected
- Pitfalls: HIGH -- every shim file and every consumer read, edge cases documented
- Consumer inventory: HIGH -- complete grep-based analysis of all imports

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable -- codebase-specific, no external dependencies)
