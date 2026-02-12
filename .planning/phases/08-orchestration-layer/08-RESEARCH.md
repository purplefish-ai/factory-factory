# Phase 8: Orchestration Layer - Research

**Researched:** 2026-02-10
**Domain:** Cross-domain orchestration patterns for TypeScript service architecture
**Confidence:** HIGH

## Summary

Phase 8 creates an explicit orchestration layer at `src/backend/orchestration/` that replaces the current implicit cross-domain calls happening through the `@/backend/services/` shim layer. Phases 1-7 successfully consolidated all 6 domains (session, workspace, github, ratchet, terminal, run-script) with barrel files and shim re-exports. The shims currently hide cross-domain violations: domain services import from `@/backend/services/foo.service` which re-exports from another domain's internal module. This phase must identify every cross-domain call, extract the coordinating logic into dedicated orchestrator files, and refactor domain services to no longer reach into sibling domains.

The codebase has two primary cross-domain flows (workspace creation and ratchet/fixer dispatch) plus numerous secondary cross-domain calls scattered across domain services. The key insight from code analysis is that most cross-domain calls fall into a few patterns: (1) a domain service directly calling another domain's service methods, (2) a domain querying another domain's in-memory state (e.g., `sessionService.isSessionWorking()`), and (3) a domain orchestrating a multi-step flow that touches multiple domains. Pattern (3) maps cleanly to orchestrators. Patterns (1) and (2) require either dependency injection of callbacks/interfaces, or moving the coordinating logic up to the orchestrator/tRPC layer.

**Primary recommendation:** Create 3-5 focused orchestrator files in `src/backend/orchestration/`, each handling one traceable flow. Orchestrators import only from domain barrel files (`@/backend/domains/{name}`). Domains receive cross-domain capabilities through callback parameters or thin interfaces, never through direct imports.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | Type system, interfaces for cross-domain contracts | Already configured |
| dependency-cruiser | 17.3.7 | Enforces no-cross-domain-imports rule | Already configured with `$1` capture group rule |
| Biome | 2.3.13 | Formatting | Already configured |
| Vitest | 4.0.18 | Test runner | Already configured |

### Supporting

No new libraries needed. This is a pure refactoring phase using existing tooling.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Explicit orchestrator files | Event-driven pub/sub | Too much indirection for a codebase this size; explicit calls are easier to trace |
| Callback injection | Full DI container (tsyringe, etc.) | Overkill; the codebase uses module-level singletons, not class-based DI |
| Orchestrator layer | Mediator pattern | Same concept, different name; "orchestrator" matches the roadmap terminology |

## Architecture Patterns

### Recommended Orchestration Directory Structure

```
src/backend/orchestration/
├── index.ts                           # Barrel for orchestration layer
├── workspace-creation.orchestrator.ts # ORCH-02: workspace + session + worktree
├── ratchet-dispatch.orchestrator.ts   # ORCH-03: github + workspace + session for fixer
├── workspace-archive.orchestrator.ts  # Archive flow: session + run-script + terminal + worktree + workspace
├── workspace-query.orchestrator.ts    # Query aggregation: workspace + session + github state
└── reconciliation.orchestrator.ts     # Reconciliation: workspace state + worktree init
```

### Pattern 1: Orchestrator Structure

**What:** Each orchestrator is a module that imports from domain barrels and coordinates a single flow.
**When to use:** Any operation that touches 2+ domains.

```typescript
// src/backend/orchestration/workspace-creation.orchestrator.ts
import { sessionService } from '@/backend/domains/session';
import { WorkspaceCreationService, worktreeLifecycleService } from '@/backend/domains/workspace';

// Orchestrator owns the cross-domain coordination
export async function createWorkspace(source: WorkspaceCreationSource, deps: WorkspaceCreationDependencies) {
  const creationService = new WorkspaceCreationService(deps);
  const result = await creationService.create(source);
  // Cross-domain: start background worktree init (which involves session domain)
  return result;
}
```

### Pattern 2: Removing Cross-Domain Imports via Callback Injection

**What:** Where a domain service currently imports from another domain's shim, refactor to accept a callback or interface parameter instead.
**When to use:** When a domain service needs a single capability from another domain (e.g., "is this session working?").

```typescript
// BEFORE (cross-domain violation in workspace/state/kanban-state.ts):
import { sessionService } from '@/backend/services/session.service';
// sessionService.isAnySessionWorking(sessionIds) called inline

// AFTER (callback injected by orchestrator):
// In kanban-state.ts: accept isAnySessionWorking as a parameter
export function computeKanbanStateForWorkspace(
  workspace: Workspace,
  isAnySessionWorking: (ids: string[]) => boolean
): WorkspaceWithKanbanState { ... }

// In orchestrator: wire the two domains together
import { sessionService } from '@/backend/domains/session';
import { computeKanbanStateForWorkspace } from '@/backend/domains/workspace';
const result = computeKanbanStateForWorkspace(workspace, sessionService.isAnySessionWorking);
```

### Pattern 3: Moving Coordination Logic to Orchestrator

**What:** For services like `worktree-lifecycle.service.ts` that are themselves cross-domain orchestrators embedded in a domain, extract the orchestration parts.
**When to use:** When a service imports from 5+ other domains (worktree-lifecycle imports from session, github, run-script, terminal, AND workspace).

```typescript
// The worktree-lifecycle service has two natures:
// 1. Pure worktree operations (git worktree create/delete) - stays in workspace domain
// 2. Cross-domain init flow (start session, run scripts, set state) - moves to orchestrator
```

### Anti-Patterns to Avoid

- **God orchestrator:** Don't create a single orchestrator file that handles everything. Each orchestrator should handle one flow.
- **Orchestrator calling orchestrator:** Orchestrators should be flat, not nested. If orchestrator A needs orchestrator B, they probably need to be merged or the common logic extracted to a domain.
- **Passing entire service objects:** Pass specific callbacks/methods, not full service instances. This keeps the contract narrow and testable.
- **Duplicating domain logic in orchestrators:** Orchestrators coordinate; they don't contain business logic. If you're writing conditional logic about ratchet states in the orchestrator, that logic belongs in the ratchet domain.

## Cross-Domain Import Inventory

This is the critical input for planning. Each entry represents a cross-domain call that must be resolved.

### Category A: Domain imports from another domain's service (via shim)

These are the violations that need orchestration.

#### Ratchet domain -> Session domain
| File | Import | Usage |
|------|--------|-------|
| `ratchet/ratchet.service.ts` | `sessionService` | `isSessionRunning()`, `isSessionWorking()`, `stopClaudeSession()`, `getClient()` |
| `ratchet/ratchet.service.ts` | `sessionDomainService` | `injectCommittedUserMessage()` |
| `ratchet/ci-fixer.service.ts` | `sessionService` | `isSessionWorking()`, `getClient()` |
| `ratchet/ci-monitor.service.ts` | `sessionService` | (not deeply analyzed, uses session for notifications) |
| `ratchet/fixer-session.service.ts` | `sessionService` | `isSessionWorking()`, `startClaudeSession()`, `getClient()` |

#### Ratchet domain -> GitHub domain
| File | Import | Usage |
|------|--------|-------|
| `ratchet/ratchet.service.ts` | `githubCLIService` | `extractPRInfo()`, `getPRFullDetails()`, `getReviewComments()`, `computeCIStatus()`, `getAuthenticatedUsername()` |
| `ratchet/ci-monitor.service.ts` | `githubCLIService` | PR/CI status fetching |

#### Ratchet domain -> Workspace domain
| File | Import | Usage |
|------|--------|-------|
| `ratchet/reconciliation.service.ts` | `workspaceStateMachine` | `markFailed()` |
| `ratchet/reconciliation.service.ts` | `initializeWorkspaceWorktree` (from trpc) | Workspace init |

#### Workspace domain -> Session domain
| File | Import | Usage |
|------|--------|-------|
| `workspace/worktree/worktree-lifecycle.service.ts` | `sessionService` | `stopWorkspaceSessions()`, `startClaudeSession()` |
| `workspace/worktree/worktree-lifecycle.service.ts` | `sessionDomainService` | `enqueue()`, `emitDelta()` |
| `workspace/worktree/worktree-lifecycle.service.ts` | `chatMessageHandlerService` | `tryDispatchNextMessage()` |
| `workspace/query/workspace-query.service.ts` | `sessionService` | `isAnySessionWorking()` |
| `workspace/state/kanban-state.ts` | `sessionService` | `isAnySessionWorking()` |

#### Workspace domain -> GitHub domain
| File | Import | Usage |
|------|--------|-------|
| `workspace/worktree/worktree-lifecycle.service.ts` | `githubCLIService` | `getAuthenticatedUsername()`, `getIssue()`, `addIssueComment()` |
| `workspace/query/workspace-query.service.ts` | `githubCLIService` | `checkHealth()`, `listReviewRequests()` |
| `workspace/query/workspace-query.service.ts` | `prSnapshotService` | `refreshWorkspace()` |

#### Workspace domain -> Run-Script domain
| File | Import | Usage |
|------|--------|-------|
| `workspace/worktree/worktree-lifecycle.service.ts` | `runScriptService` | `stopRunScript()` |
| `workspace/worktree/worktree-lifecycle.service.ts` | `startupScriptService` | `runStartupScript()`, `hasStartupScript()` |

#### Workspace domain -> Terminal domain
| File | Import | Usage |
|------|--------|-------|
| `workspace/worktree/worktree-lifecycle.service.ts` | `terminalService` | `destroyWorkspaceTerminals()` |

#### GitHub domain -> Ratchet domain
| File | Import | Usage |
|------|--------|-------|
| `github/pr-review-fixer.service.ts` | `fixerSessionService` | `acquireAndDispatch()` |

#### GitHub domain -> Session domain
| File | Import | Usage |
|------|--------|-------|
| `github/pr-review-fixer.service.ts` | `sessionService` | `isSessionWorking()`, `getClient()` |

#### GitHub domain -> Workspace domain
| File | Import | Usage |
|------|--------|-------|
| `github/pr-snapshot.service.ts` | `kanbanStateService` | `updateCachedKanbanColumn()` |

#### Session domain -> Workspace domain
| File | Import | Usage |
|------|--------|-------|
| `session/chat/chat-event-forwarder.service.ts` | `workspaceActivityService` | `recordSessionActivity()` |
| `session/chat/chat-message-handlers.service.ts` | `getWorkspaceInitPolicy` | Workspace init state |

#### Run-Script domain -> Workspace domain
| File | Import | Usage |
|------|--------|-------|
| `run-script/startup-script.service.ts` | `workspaceStateMachine` | `markReady()`, `markFailed()` |

### Category B: Infrastructure imports (NOT violations)

These are imports from shared infrastructure services that stay in `services/` and are NOT cross-domain violations:

- `createLogger` from `logger.service` - used everywhere, stays in services/
- `configService` from `config.service` - shared infrastructure
- `constants` from `constants` - shared values
- `FactoryConfigService` from `factory-config.service` - shared utility
- `gitOpsService` from `git-ops.service` - shared git utility
- `RateLimitBackoff` from `rate-limit-backoff` - shared utility
- `slashCommandCacheService` - shared infrastructure
- `PortAllocationService` - shared infrastructure

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-domain dependency enforcement | Custom lint scripts | dependency-cruiser `no-cross-domain-imports` rule | Already configured with `$1` group capture, battle-tested |
| Service wiring | DI container | Module-level singletons + explicit orchestrator imports | Matches existing codebase patterns |
| Event bus for cross-domain | Custom pub/sub | Direct orchestrator function calls | Explicit is better than implicit for this codebase size |

**Key insight:** The existing `no-cross-domain-imports` dependency-cruiser rule will automatically catch any remaining violations once the shim imports are replaced with domain barrel imports. The rule uses `$1` group capture to ensure `domains/X/` never imports from `domains/Y/`.

## Common Pitfalls

### Pitfall 1: Worktree Lifecycle is the Hardest File
**What goes wrong:** `worktree-lifecycle.service.ts` imports from 6+ other domains. Trying to refactor it all at once leads to regressions.
**Why it happens:** This file is the original "god service" for workspace initialization. It touches session, github, run-script, terminal, and workspace state machine.
**How to avoid:** Split it in two: (1) pure worktree operations stay in workspace domain, (2) the `initializeWorkspaceWorktree` and `archiveWorkspace` flows move to orchestration. The `startDefaultClaudeSession` helper function is pure cross-domain orchestration and should move entirely.
**Warning signs:** If the orchestrator file for workspace init exceeds 200 lines of actual logic (not types/imports), some logic probably belongs back in a domain.

### Pitfall 2: Circular Orchestrator Dependencies
**What goes wrong:** Orchestrator A calls domain X which needs orchestrator B which calls domain X.
**Why it happens:** Moving coordination logic up to orchestrators without cleaning the downward dependency.
**How to avoid:** Domains NEVER import from orchestrators. Information flows down: orchestrator -> domain. If a domain needs to trigger a cross-domain flow, it should accept a callback.
**Warning signs:** Any import from `@/backend/orchestration/` inside `@/backend/domains/`.

### Pitfall 3: Reconciliation Service's trpc Import
**What goes wrong:** `reconciliation.service.ts` currently imports `initializeWorkspaceWorktree` from `@/backend/trpc/workspace/init.trpc`. This is a layer violation (domain importing from tRPC layer).
**Why it happens:** The workspace init function was originally defined in the tRPC router file.
**How to avoid:** Move `initializeWorkspaceWorktree` to the workspace-creation orchestrator. Both tRPC and reconciliation can call it from there.
**Warning signs:** Any domain or orchestrator importing from `@/backend/trpc/`.

### Pitfall 4: Shim Dependencies Must Stay Until Phase 9
**What goes wrong:** Removing shim files prematurely breaks imports elsewhere in the codebase (tRPC routers, app-context, etc.).
**Why it happens:** Eagerness to clean up. Phase 8 only touches domain internals; Phase 9 rewires all external consumers.
**How to avoid:** Domain services stop importing cross-domain shims (they use injected callbacks or orchestrators instead). But the shim files at `@/backend/services/` must remain for tRPC, app-context, and other non-domain consumers until Phase 9.
**Warning signs:** Running `pnpm typecheck` fails after removing a shim.

### Pitfall 5: Breaking Test Mocks
**What goes wrong:** Tests mock `@/backend/services/session.service` but the real code now uses a callback parameter. Mock paths break.
**Why it happens:** The refactoring changes how services are wired, but tests were written against the old import paths.
**How to avoid:** Update test files alongside production code. Callback-based designs are actually easier to test (pass mock functions directly, no module mocking needed).
**Warning signs:** Tests that mock module paths instead of injecting test doubles.

### Pitfall 6: Session Domain Self-Imports Through Shims
**What goes wrong:** Several session domain files import `sessionService` from `@/backend/services/session.service` (the shim) instead of using intra-domain relative imports.
**Why it happens:** These were historical imports that weren't cleaned up during Phase 2.
**How to avoid:** As part of orchestration work, also clean up intra-domain imports that go through the shim layer. Files within `domains/session/` should import from `../lifecycle/session.service` (relative) not from `@/backend/services/session.service` (shim).
**Warning signs:** `session/chat/` files importing from `@/backend/services/session.service` -- these are same-domain calls going through the shim unnecessarily.

## Code Examples

### Example 1: Workspace Archive Orchestrator

```typescript
// src/backend/orchestration/workspace-archive.orchestrator.ts
import { sessionService } from '@/backend/domains/session';
import { runScriptService } from '@/backend/domains/run-script';
import { terminalService } from '@/backend/domains/terminal';
import { worktreeLifecycleService, workspaceStateMachine } from '@/backend/domains/workspace';
import { githubCLIService } from '@/backend/domains/github';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('workspace-archive-orchestrator');

export async function archiveWorkspace(
  workspace: WorkspaceWithProject,
  options: { commitUncommitted: boolean }
) {
  // Stop all cross-domain resources
  try {
    await sessionService.stopWorkspaceSessions(workspace.id);
    await runScriptService.stopRunScript(workspace.id);
    terminalService.destroyWorkspaceTerminals(workspace.id);
  } catch (error) {
    logger.error('Failed to cleanup workspace resources', { ... });
  }

  // Worktree cleanup (stays in workspace domain - pure git ops)
  await worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, options);

  // State transition (workspace domain)
  const archived = await workspaceStateMachine.archive(workspace.id);

  // Cross-domain: GitHub issue comment
  await handleGitHubIssueOnArchive(workspace);

  return archived;
}
```

### Example 2: Ratchet Dispatch Orchestrator

```typescript
// src/backend/orchestration/ratchet-dispatch.orchestrator.ts
import { sessionService, sessionDomainService } from '@/backend/domains/session';
import { githubCLIService } from '@/backend/domains/github';
import { ratchetService, fixerSessionService } from '@/backend/domains/ratchet';
import { createLogger } from '@/backend/services/logger.service';

// The ratchet service needs session capabilities.
// Inject them rather than having ratchet import session directly.
export function createRatchetSessionBridge() {
  return {
    isSessionRunning: (id: string) => sessionService.isSessionRunning(id),
    isSessionWorking: (id: string) => sessionService.isSessionWorking(id),
    stopClaudeSession: (id: string) => sessionService.stopClaudeSession(id),
    getClient: (id: string) => sessionService.getClient(id),
    startClaudeSession: (id: string, opts: any) => sessionService.startClaudeSession(id, opts),
    injectCommittedUserMessage: (id: string, msg: string) =>
      sessionDomainService.injectCommittedUserMessage(id, msg),
  };
}
```

### Example 3: Kanban State with Injected Dependency

```typescript
// workspace/state/kanban-state.ts (AFTER - no more cross-domain import)
export class KanbanStateService {
  // Accept session-checking capability as a parameter
  async getWorkspaceKanbanState(
    workspaceId: string,
    isAnySessionWorking: (ids: string[]) => boolean
  ): Promise<WorkspaceWithKanbanState | null> {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) return null;

    const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
    const isSessionWorking = isAnySessionWorking(sessionIds);
    // ... rest of logic
  }
}
```

## Key Design Decisions

### Decision 1: Where Does Ratchet Flow Logic Live?

The ratchet service (`ratchet.service.ts`) is itself already an orchestrator -- it coordinates GitHub API calls, workspace state checks, and session dispatch. Two approaches:

**Option A: Move entire ratchet.service.ts to orchestration/**
- Pro: Clean separation. Ratchet domain only has fixer-session, ci-fixer, ci-monitor, reconciliation.
- Con: Moves a lot of code. Ratchet domain becomes very thin.

**Option B: Keep ratchet.service.ts in domain, inject cross-domain deps**
- Pro: Less code movement. Ratchet polling/state-machine logic stays together.
- Con: Requires interface/callback injection for session and github capabilities.

**Recommendation: Option B** -- inject dependencies. The ratchet service's polling loop and state machine logic are core ratchet domain behavior. Only the cross-domain wiring should change. The orchestrator creates the bridges and starts the service.

### Decision 2: WorktreeLifecycleService Split

The `worktree-lifecycle.service.ts` file contains:
1. **Pure worktree operations:** `cleanupWorkspaceWorktree`, `setInitMode`, `getInitMode`, resume mode file handling -- these stay in workspace domain.
2. **Cross-domain initialization flow:** `initializeWorkspaceWorktree` (calls session, github, run-script, terminal) -- moves to orchestrator.
3. **Cross-domain archive flow:** `archiveWorkspace` (calls session, run-script, terminal, github) -- moves to orchestrator.

**Recommendation:** Extract `initializeWorkspaceWorktree` and `archiveWorkspace` into orchestrators. The remaining `WorktreeLifecycleService` becomes a pure worktree manager.

### Decision 3: Dependency Injection Approach

The codebase uses module-level singletons, not class-based DI. Two injection patterns are appropriate:

1. **Function parameters** (for pure functions like `computeKanbanColumn`): pass callbacks directly.
2. **Service initialization** (for stateful services like `RatchetService`): orchestrator calls a `configure()` or `setBridge()` method at startup.

```typescript
// Pattern: Bridge configuration at startup
// In orchestrator:
ratchetService.configure({
  sessionBridge: createRatchetSessionBridge(),
  githubBridge: createRatchetGithubBridge(),
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct service-to-service imports | Shim re-exports hiding cross-domain deps | Phases 2-7 (current) | Violations hidden but not eliminated |
| Implicit cross-domain calls | Explicit orchestration layer | Phase 8 (this phase) | All cross-domain flows visible and traceable |

## Dependency-Cruiser Rule Status

The existing `no-cross-domain-imports` rule (line 101-111 of `.dependency-cruiser.cjs`) already enforces that `domains/X/` cannot import from `domains/Y/`. Currently passing because cross-domain calls go through `@/backend/services/` shims (which are outside the `domains/` path).

After Phase 8:
- Domain files that previously imported from shims will instead receive capabilities via injection or will have their orchestrating logic moved up to `orchestration/`.
- The dependency-cruiser rule will continue to pass.
- The orchestration layer needs to be permitted to import from all domains. May need to add a rule allowing `orchestration/ -> domains/` (currently implicitly allowed since the rule only restricts `domains/ -> domains/`).

## Open Questions

1. **How to handle `reconciliation.service.ts` importing from tRPC?**
   - What we know: It imports `initializeWorkspaceWorktree` from `@/backend/trpc/workspace/init.trpc`
   - What's unclear: Whether to move `initializeWorkspaceWorktree` to orchestration (recommended) or create a shared function
   - Recommendation: Move it to workspace-init orchestrator; both tRPC and reconciliation import from there

2. **Should `chatEventForwarderService.workspaceActivityService` cross-domain call be orchestrated?**
   - What we know: Session domain's chat-event-forwarder calls `workspaceActivityService.recordSessionActivity()`
   - What's unclear: This is a fire-and-forget side effect, not a coordinated flow
   - Recommendation: Use an event callback injected at startup rather than a full orchestrator

3. **How to handle intra-domain shim imports (session domain self-referencing through shims)?**
   - What we know: Many `session/chat/` files import from `@/backend/services/session.service` instead of relative paths
   - What's unclear: Whether to fix these in Phase 8 or defer to Phase 9
   - Recommendation: Fix them in Phase 8 as a prerequisite step -- it reduces the cross-domain surface area and makes the orchestration changes cleaner

## Sources

### Primary (HIGH confidence)
- **Codebase analysis** - Direct reading of all 6 domain barrel files, all cross-domain import paths, dependency-cruiser config, app-context.ts
- **Dependency-cruiser config** - `.dependency-cruiser.cjs` lines 101-111, `no-cross-domain-imports` rule verified working
- **Roadmap** - `.planning/ROADMAP.md` Phase 8 requirements (ORCH-01, ORCH-02, ORCH-03)
- **pnpm typecheck** - Verified passing on current branch

### Secondary (MEDIUM confidence)
- **Architecture patterns** - Based on established patterns in the existing codebase (barrel files, shim re-exports, singleton services)

### Tertiary (LOW confidence)
- None -- all findings from direct codebase analysis

## Metadata

**Confidence breakdown:**
- Cross-domain import inventory: HIGH - exhaustive grep of all domain files
- Architecture patterns: HIGH - derived from existing codebase conventions
- Orchestration file structure: MEDIUM - reasonable inference from requirements, but exact file boundaries depend on implementation
- Pitfalls: HIGH - identified from direct code analysis of the files that will change

**Research date:** 2026-02-10
**Valid until:** Indefinite (codebase-specific research, not library version dependent)
