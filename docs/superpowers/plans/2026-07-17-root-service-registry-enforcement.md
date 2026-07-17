# Root Service Registry Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the filename-derived root-service exemption with an explicit infrastructure registry and relocate domain-owned services into the run-script and workspace capsules.

**Architecture:** Seven truly cross-cutting root services and two shared root helper modules remain as documented infrastructure capabilities. Seven domain services move behind capsule barrels; factory-config endpoints move from workspace query ownership into run-script so the existing `run-script -> workspace` dependency stays acyclic and complete.

**Tech Stack:** TypeScript, Vitest, Express/tRPC, service-capsule registry checker, Dependency Cruiser, Biome, pnpm.

## Global Constraints

- Cross-service consumers import only from `@/backend/services/<service>` barrels.
- Service-to-service dependencies must match `dependsOn` in `src/backend/services/registry.ts`.
- Runtime behavior and public API shapes remain unchanged.
- Root tests and non-service helpers are not infrastructure service entries.
- Implement behavior changes test-first and verify each red/green cycle.

---

### Task 1: Enforce explicit root infrastructure classification

**Files:**
- Create: `src/backend/services/service-registry-check.test.ts`
- Create: `src/backend/services/service-registry-check.helpers.ts`
- Modify: `src/backend/services/registry.ts`
- Modify: `scripts/check-service-registry.ts`

**Interfaces:**
- Consumes: root production service filenames matching `*.service.ts`.
- Produces: `infrastructureServiceRegistry`, keyed by exact module names such as `logger.service`, and checker errors for unclassified or missing infrastructure services.

- [ ] **Step 1: Write the failing unclassified-root test**

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getInfrastructureServiceClassificationErrors } from './service-registry-check.helpers';
import { infrastructureServiceRegistry } from './registry';

describe('check-service-registry root infrastructure classification', () => {
  let servicesRoot: string;

  beforeEach(() => {
    servicesRoot = mkdtempSync(path.join(tmpdir(), 'ff-service-registry-'));
    for (const { fileName } of Object.values(infrastructureServiceRegistry)) {
      writeFileSync(path.join(servicesRoot, fileName), 'export {};\n');
    }
  });

  afterEach(() => rmSync(servicesRoot, { recursive: true, force: true }));

  it('rejects a root service that is not explicitly registered as infrastructure', () => {
    writeFileSync(path.join(servicesRoot, 'unclassified.service.ts'), 'export {};\n');
    const errors = getInfrastructureServiceClassificationErrors(
      servicesRoot,
      infrastructureServiceRegistry
    );

    expect(errors).toContain(
      'unclassified.service.ts is a root service that is not registered as infrastructure. Move it into its owning service capsule or add an intentional entry to infrastructureServiceRegistry.'
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the blanket exemption makes it fail**

Run: `pnpm vitest run src/backend/services/service-registry-check.test.ts`

Expected: FAIL because the current classification logic returns no error for the temporary root service.

- [ ] **Step 3: Add the explicit registry and bidirectional validation**

Add `infrastructureServiceRegistry` entries for the seven root services plus the two root helper modules imported by capsules. Each entry records its exact filename:

```ts
export const infrastructureServiceRegistry = {
  'config.service': { fileName: 'config.service.ts', description: 'Environment and application configuration' },
  constants: { fileName: 'constants.ts', description: 'Shared backend service timing and retry constants' },
  'crypto.service': { fileName: 'crypto.service.ts', description: 'Encryption for secrets stored at rest' },
  'logger.service': { fileName: 'logger.service.ts', description: 'Process-wide structured logging' },
  'notification.service': { fileName: 'notification.service.ts', description: 'Operating-system notifications' },
  'port.service': { fileName: 'port.service.ts', description: 'Backend server port probing' },
  'rate-limit-backoff': { fileName: 'rate-limit-backoff.ts', description: 'Shared API rate-limit retry policy' },
  'rate-limiter.service': { fileName: 'rate-limiter.service.ts', description: 'Process-wide API request rate limiting' },
  'server-instance.service': { fileName: 'server-instance.service.ts', description: 'Active HTTP server instance state' },
} as const;
```

In `check-service-registry.ts`, replace the `readdirSync`-derived exemption with exact keys from this object. Add `checkInfrastructureServiceClassification()` that compares root `*.service.ts` files in both directions and appends actionable errors. Call it from `main()` before cross-service import validation.

- [ ] **Step 4: Run focused checks and verify green**

Run: `pnpm vitest run src/backend/services/service-registry-check.test.ts && pnpm check:service-registry`

Expected: PASS after the domain root files are temporarily listed during the move or after Task 3 completes; while Tasks 2–3 are in progress, the checker should intentionally report each still-unmoved domain root.

- [ ] **Step 5: Commit the enforcement change with the completed moves**

The registry cannot pass until Tasks 2–3 remove all unclassified domain roots, so stage this task with those moves and commit at the first green architecture checkpoint.

---

### Task 2: Move run-script configuration and proxy services

**Files:**
- Move: `src/backend/services/factory-config.service.ts` → `src/backend/services/run-script/service/factory-config.service.ts`
- Move: `src/backend/services/factory-config.service.test.ts` → `src/backend/services/run-script/service/factory-config.service.test.ts`
- Move: `src/backend/services/port-allocation.service.ts` → `src/backend/services/run-script/service/port-allocation.service.ts`
- Move: `src/backend/services/port-allocation.service.test.ts` → `src/backend/services/run-script/service/port-allocation.service.test.ts`
- Move: `src/backend/services/run-script-config-persistence.service.ts` → `src/backend/services/run-script/service/run-script-config-persistence.service.ts`
- Move: `src/backend/services/run-script-config-persistence.service.test.ts` → `src/backend/services/run-script/service/run-script-config-persistence.service.test.ts`
- Move: `src/backend/services/run-script-proxy.service.ts` → `src/backend/services/run-script/service/run-script-proxy.service.ts`
- Move: `src/backend/services/run-script-proxy.service.test.ts` → `src/backend/services/run-script/service/run-script-proxy.service.test.ts`
- Modify: `src/backend/services/run-script/service/index.ts`
- Modify: `src/backend/services/run-script/service/run-script-domain-exports.test.ts`
- Modify: `src/backend/services/run-script/service/run-script.service.ts`
- Modify: `src/backend/services/run-script/service/run-script-process-utils.ts`
- Modify: `src/backend/services/workspace/service/query/workspace-query.service.ts`
- Modify: `src/backend/services/workspace/service/query/workspace-query.service.test.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`
- Modify: `src/backend/trpc/workspace/run-script.trpc.ts`
- Modify: `src/backend/trpc/project.trpc.ts`
- Modify: `src/backend/orchestration/workspace-init.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-init-script-pipeline.ts`
- Modify related mocks importing the four old module paths.

**Interfaces:**
- Consumes: `projectAccessor` and `workspaceAccessor` from the workspace barrel under the existing `run-script -> workspace` dependency.
- Produces: `FactoryConfigService`, `PortAllocationService`, `RunScriptProxyService`, `runScriptConfigPersistenceService`, `refreshFactoryConfigs(projectId)`, and `getFactoryConfig(projectId)` from the run-script barrel.

- [ ] **Step 1: Extend the run-script barrel smoke test before exports exist**

Add imports and assertions:

```ts
import {
  FactoryConfigService,
  PortAllocationService,
  RunScriptProxyService,
  runScriptConfigPersistenceService,
} from './index';

expect(typeof FactoryConfigService.readConfig).toBe('function');
expect(typeof PortAllocationService.findFreePort).toBe('function');
expect(typeof RunScriptProxyService).toBe('function');
expect(runScriptConfigPersistenceService).toBeDefined();
```

- [ ] **Step 2: Run the barrel test and verify red**

Run: `pnpm vitest run src/backend/services/run-script/service/run-script-domain-exports.test.ts`

Expected: FAIL because the barrel does not export the domain services.

- [ ] **Step 3: Move implementations/tests and export the public API**

Use `git mv` for the eight files. Export the four APIs and related types from `src/backend/services/run-script/service/index.ts`. Convert same-capsule imports in run-script implementation files to relative imports and external production imports to `@/backend/services/run-script`.

- [ ] **Step 4: Move factory-config query ownership test-first**

Move the existing `refreshFactoryConfigs` and `getFactoryConfig` cases from `workspace-query.service.test.ts` into `run-script-config-persistence.service.test.ts`. Mock workspace accessors from the workspace barrel, then add equivalent methods to the persistence service:

```ts
refreshFactoryConfigs(projectId: string): Promise<{
  updatedCount: number;
  totalWorkspaces: number;
  errors: Array<{ workspaceId: string; error: string }>;
}>;

getFactoryConfig(projectId: string): Promise<FactoryConfig | null>;
```

Run the moved tests before implementation and confirm they fail because the methods are absent. Then implement them using `workspaceAccessor.findByProjectId`, `workspaceAccessor.update`, and `projectAccessor.findById`, preserving current logging and partial-failure behavior.

- [ ] **Step 5: Update endpoint and orchestration consumers**

Import the moved APIs from the run-script barrel. Route `workspace.trpc.ts` configuration calls to `runScriptConfigPersistenceService`. Remove factory-config persistence imports, mocks, methods, and tests from workspace query. Update project tRPC and workspace initialization code to import `FactoryConfigService` from run-script.

- [ ] **Step 6: Run focused run-script, workspace-query, tRPC, and orchestrator tests**

Run: `pnpm vitest run src/backend/services/run-script src/backend/services/workspace/service/query/workspace-query.service.test.ts src/backend/trpc/workspace.router.test.ts src/backend/trpc/workspace/run-script.router.test.ts src/backend/trpc/project.router.test.ts src/backend/orchestration/workspace-init.orchestrator.test.ts`

Expected: PASS.

---

### Task 3: Move workspace git and snapshot services

**Files:**
- Move: `src/backend/services/git-clone.service.ts` → `src/backend/services/workspace/service/worktree/git-clone.service.ts`
- Move: `src/backend/services/git-clone.service.test.ts` → `src/backend/services/workspace/service/worktree/git-clone.service.test.ts`
- Move: `src/backend/services/git-ops.service.ts` → `src/backend/services/workspace/service/worktree/git-ops.service.ts`
- Move: `src/backend/services/git-ops.service.test.ts` → `src/backend/services/workspace/service/worktree/git-ops.service.test.ts`
- Move: `src/backend/services/workspace-snapshot-store.service.ts` → `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.ts`
- Move: `src/backend/services/workspace-snapshot-store.service.test.ts` → `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.test.ts`
- Modify: `src/backend/services/workspace/service/index.ts`
- Modify: `src/backend/services/workspace/service/workspace-domain-exports.test.ts`
- Modify: `src/backend/lib/session-summaries.ts`
- Modify production consumers and mocks in orchestration, routers, tRPC, and workspace internals.

**Interfaces:**
- Produces: `gitCloneService`, `parseGithubUrl`, `gitOpsService`, `WorkspaceSnapshotStore`, `workspaceSnapshotStore`, and snapshot contract types from the workspace barrel.

- [ ] **Step 1: Extend the workspace barrel smoke test before exports exist**

Add imports and assertions:

```ts
import {
  gitCloneService,
  gitOpsService,
  WorkspaceSnapshotStore,
  workspaceSnapshotStore,
} from './index';

expect(gitCloneService).toBeDefined();
expect(gitOpsService).toBeDefined();
expect(typeof WorkspaceSnapshotStore).toBe('function');
expect(workspaceSnapshotStore).toBeDefined();
```

- [ ] **Step 2: Run the workspace barrel test and verify red**

Run: `pnpm vitest run src/backend/services/workspace/service/workspace-domain-exports.test.ts`

Expected: FAIL because the barrel does not export the moved services.

- [ ] **Step 3: Move implementations/tests and update capsule internals**

Use `git mv` for the six files. Export their APIs from `src/backend/services/workspace/service/index.ts`. Use relative paths from workspace internals and barrel imports from orchestration, routers, and tRPC.

Change `src/backend/lib/session-summaries.ts` to use `SessionSummary` directly:

```ts
import type { SessionSummary } from '@/shared/session-runtime';

export function buildWorkspaceSessionSummaries(...): SessionSummary[];
```

This avoids a low-level lib-to-capsule barrel cycle.

- [ ] **Step 4: Update all old module mocks and type imports**

Use `rg 'git-(clone|ops)\.service|workspace-snapshot-store\.service' src` and replace every external production import with the workspace barrel. Keep moved unit tests on relative imports. Update `vi.mock` paths so mocks intercept the actual barrel import used by production code.

- [ ] **Step 5: Run focused workspace and snapshot consumers**

Run: `pnpm vitest run src/backend/services/workspace src/backend/orchestration/domain-bridges.orchestrator.test.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts src/backend/routers/websocket/snapshots.handler.test.ts src/backend/trpc/project.router.test.ts`

Expected: PASS.

- [ ] **Step 6: Complete the architecture checkpoint and commit**

Run: `pnpm check:service-registry && pnpm deps:check && pnpm typecheck`

Expected: all three exit 0, with no root domain services remaining. Then commit:

```bash
git add src scripts docs/superpowers
git commit -m "Enforce root service classifications (#1958)"
```

---

### Task 4: Full verification, review, and pull request

**Files:**
- Review: all changes against `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Produces: a clean, pushed issue branch and a GitHub pull request closing #1958.

- [ ] **Step 1: Run the required verification sequence**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all commands exit 0. Review any `check:fix` edits and fix failures without unrelated changes. Also rerun `pnpm check:service-registry && pnpm deps:check` explicitly.

- [ ] **Step 2: Review the complete diff**

Run: `git diff origin/main`, `git diff --check`, and `git status --short`.

Confirm there are no old root-domain import paths, debug logs, commented code, accidental formatting churn, or uncommitted files. If the change spans eight or more files, use the code-simplifier review requested by the workflow and rerun affected tests after any edit.

- [ ] **Step 3: Commit final verification edits**

```bash
git add -A
git commit -m "Finish service registry enforcement (#1958)"
```

Skip the commit only if the worktree is already clean.

- [ ] **Step 4: Push and create the required PR**

Run `git push -u origin HEAD`. Write `/tmp/pr-body.md` with Summary, Changes, Testing, `Closes #1958`, and the required final signature:

```markdown
---
🏭 Forged in [Factory Factory](https://factoryfactory.ai)
```

Then run:

```bash
gh pr create --title "Fix #1958: Enforce root service classifications" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: a new pull request URL with state `OPEN`.
