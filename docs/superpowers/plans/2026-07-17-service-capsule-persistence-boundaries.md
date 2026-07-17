# Service Capsule Persistence Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide raw persistence accessors behind capsule-owned application APIs and prevent future accessor leakage.

**Architecture:** Keep accessors private to their owning capsule. Extend existing services and add intent-focused services where public use cases are missing; transport and cross-service callers import only capsule barrels. A TypeScript-AST guard rejects raw re-exports, aliases and indirect re-export chains, dynamic imports and supported loader calls, and cross-owner imports, with one exact backup-orchestration exception.

**Tech Stack:** TypeScript, Express/tRPC, Prisma, Vitest, TypeScript compiler API, Biome, pnpm

## Global Constraints

- Top-level capsule barrels must not export raw persistence accessors.
- tRPC and cross-service consumers must call public service/use-case APIs.
- Settings APIs belong to the settings capsule.
- `periodic-task.trpc.ts` must not import `periodicTaskAccessor`.
- Preserve existing Prisma model ownership, CAS behavior, scheduling behavior, and transport errors.
- Do not add a generic public `findRawById` or an accessor-shaped pass-through service.
- The only permitted cross-owner resource import is `dataBackupAccessor` from `src/backend/orchestration/data-backup.service.ts`, documented in the guard policy.

---

### Task 1: Add the accessor-boundary guardrail

**Files:**
- Create: `scripts/check-service-accessor-boundaries.mjs`
- Create: `src/backend/services/check-service-accessor-boundaries.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: TypeScript source trees under `src/backend`.
- Produces: a CLI that exits nonzero for raw capsule re-exports, raw barrel imports, and cross-owner deep accessor imports.

- [ ] **Step 1: Write failing fixture tests**

Create fixtures that invoke the checker against a temporary source root. Assert owner-internal imports pass; a capsule `index.ts` re-exporting `./resources/example.accessor` fails; local and exported accessor aliases fail; indirect named/star re-export chains fail; type-only, dynamic `import()`, and loader `CallExpression` references fail; tRPC/barrel accessor imports fail; cross-service deep imports fail; and the exact backup exception passes.

```ts
expect(runChecker([{ path: 'src/backend/services/workspace/index.ts', content: "export * from './resources/workspace.accessor';" }]).output)
  .toContain('raw persistence accessor');
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/backend/services/check-service-accessor-boundaries.test.ts`

Expected: FAIL because `scripts/check-service-accessor-boundaries.mjs` does not exist.

- [ ] **Step 3: Implement the AST checker and wire it into ownership checks**

Use an explicit owner map for `projectAccessor`, `workspaceAccessor`, `workspaceNotificationAccessor`, `agentSessionAccessor`, `closedSessionAccessor`, `userSettingsAccessor`, `healthAccessor`, `dataBackupAccessor`, `terminalSessionAccessor`, `decisionLogAccessor`, and `periodicTaskAccessor`. Parse import/export declarations with TypeScript, include type-only imports, dynamic imports, and explicitly supported loader calls, propagate accessor identity through local aliases and indirect re-export chains, and keep the exception keyed by exact importer and exact module.

Update:

```json
"check:ownership": "node scripts/check-service-accessor-boundaries.mjs && node scripts/check-single-writer.mjs && pnpm check:service-registry"
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/backend/services/check-service-accessor-boundaries.test.ts`

Expected: all guardrail fixtures pass.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/check-service-accessor-boundaries.mjs src/backend/services/check-service-accessor-boundaries.test.ts
git commit -m "Guard service accessor boundaries (#1956)"
```

### Task 2: Move settings and decision-log APIs into their capsules

**Files:**
- Create: `src/backend/services/settings/service/user-settings.service.ts`
- Create: `src/backend/services/settings/service/health.service.ts`
- Create: `src/backend/services/settings/service/index.ts`
- Create: `src/backend/services/settings/service/settings-domain-exports.test.ts`
- Modify: `src/backend/services/settings/index.ts`
- Delete: `src/backend/services/workspace/service/query/user-settings-query.service.ts`
- Modify: `src/backend/services/workspace/service/index.ts`
- Modify: `src/backend/trpc/user-settings.trpc.ts`
- Modify: `src/backend/trpc/workspace/ide.trpc.ts`
- Modify: `src/backend/orchestration/health.service.ts`
- Modify: `src/backend/orchestration/data-backup.service.ts`
- Create: `src/backend/services/decision-log/service/decision-log.service.ts`
- Create: `src/backend/services/decision-log/service/index.ts`
- Create: `src/backend/services/decision-log/service/decision-log-domain-exports.test.ts`
- Modify: `src/backend/services/decision-log/index.ts`
- Delete: `src/backend/orchestration/decision-log-query.service.ts`
- Modify: `src/backend/trpc/decision-log.trpc.ts`
- Modify: `src/backend/trpc/admin.trpc.ts`
- Modify: settings consumers and their co-located tests under `src/backend/services/session/`, `src/backend/services/ratchet/`, and `src/backend/services/workspace/service/lifecycle/creation.service.ts`.

**Interfaces:**
- Produces: `userSettingsService.get/update/getDefaultSessionProvider/getWorkspaceOrder/updateWorkspaceOrder/compareAndSetCachedSlashCommands`, `settingsHealthService.checkDatabaseConnection`, and `decisionLogService.findByAgentId/findRecent/findById/list/createAutomatic/createManual`.

- [ ] **Step 1: Add failing public-export and consumer tests**

Tests import the three services from their owning top-level barrels and assert they are defined. Update a settings consumer test to mock `userSettingsService` so it fails against the old barrel.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/backend/services/settings/service/settings-domain-exports.test.ts src/backend/services/decision-log/service/decision-log-domain-exports.test.ts`

Expected: FAIL because the service modules are missing.

- [ ] **Step 3: Implement capsule-owned APIs and migrate consumers**

Move the workspace settings wrapper into settings, add provider/cache methods, move the decision-log wrapper into its owner, and make health delegate to the settings service. Change backup to the exact guarded deep import. Preserve method return types and existing errors.

- [ ] **Step 4: Verify GREEN and scan leakage**

Run: `pnpm vitest run src/backend/trpc/user-settings.router.test.ts src/backend/trpc/decision-log.router.test.ts src/backend/services/session/service/store/slash-command-cache.service.test.ts src/backend/services/ratchet/service/ratchet-provider-resolver.service.test.ts`

Run: `node scripts/check-service-accessor-boundaries.mjs`

Expected: focused tests pass; remaining violations do not include settings or decision-log consumers.

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/settings src/backend/services/decision-log src/backend/services/workspace/service src/backend/services/session src/backend/services/ratchet src/backend/orchestration src/backend/trpc
git commit -m "Own settings and decision log APIs (#1956)"
```

### Task 3: Route periodic-task transport through its service

**Files:**
- Modify: `src/backend/services/periodic-task/service/periodic-task.service.ts`
- Modify: `src/backend/services/periodic-task/service/periodic-task.service.test.ts`
- Modify: `src/backend/services/periodic-task/index.ts`
- Modify: `src/backend/trpc/periodic-task.trpc.ts`

**Interfaces:**
- Produces: periodic-task administration and query operations plus scheduler-owned execution reservation and dispatch APIs. The service owns schedule validation, default query limits, and dispatch orchestration; the capsule resource computes persisted next-run state and conditionally reserves execution in one transaction.

- [ ] **Step 1: Write failing service API tests**

Test application behavior at the service boundary: the default execution limit is 20, toggling preserves schedule invariants, schedule updates validate and recompute the next run, and concurrent execution reservation is atomic. Router tests should assert delegation to these public operations.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/backend/services/periodic-task/service/periodic-task.service.test.ts`

Expected: FAIL because the application operations and their invariants are absent.

- [ ] **Step 3: Implement methods and migrate tRPC**

Expose administration, query, and scheduler operations from `PeriodicTaskService`; validate schedules at the service boundary and keep conditional reservation plus next-run persistence atomic inside the capsule resource. Replace every router accessor call with the service API and stop exporting the accessor from the capsule barrel.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/backend/services/periodic-task/service/periodic-task.service.test.ts`

Run: `rg -n 'periodicTaskAccessor' src/backend/trpc/periodic-task.trpc.ts src/backend/services/periodic-task/index.ts`

Expected: tests pass and the scan has no matches.

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/periodic-task src/backend/trpc/periodic-task.trpc.ts
git commit -m "Route periodic task CRUD through service (#1956)"
```

### Task 4: Establish terminal and session application APIs

**Files:**
- Create: `src/backend/services/terminal/service/terminal-session.service.ts`
- Modify: `src/backend/services/terminal/service/index.ts`
- Modify: `src/backend/services/terminal/index.ts`
- Create: `src/backend/services/terminal/service/terminal-domain-exports.test.ts`
- Modify: `src/backend/services/session/service/data/session-data.service.ts`
- Modify: `src/backend/services/session/service/data/session-provider-resolver.service.ts`
- Modify: `src/backend/services/session/resources/agent-session.accessor.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.repository.ts`
- Modify: `src/backend/orchestration/reconciliation.service.ts`
- Modify: `src/backend/trpc/session.trpc.ts`
- Modify: `src/backend/trpc/admin.trpc.ts`
- Modify: `src/backend/routers/websocket/terminal.handler.ts`
- Modify: `src/backend/orchestration/workspace-init.orchestrator.ts`
- Modify: `src/backend/services/session/service/data/session-provider-resolver.service.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.repository.test.ts`
- Modify: `src/backend/services/ratchet/service/fixer-session.service.test.ts`
- Modify: `src/backend/orchestration/reconciliation.service.test.ts`
- Modify: `src/backend/orchestration/workspace-init.orchestrator.test.ts`
- Modify: `src/backend/trpc/session.router.test.ts`

**Interfaces:**
- Produces: terminal-owned lifecycle APIs that preserve terminal ownership, orphan-cleanup, and PID-recovery invariants, plus session-owned atomic fixer acquisition/recovery operations.
- Consumes: resolved provider/model defaults at the session service boundary; the agent-session resource no longer imports settings.

- [ ] **Step 1: Write failing tests for terminal exports and fixer acquisition**

Assert `terminalSessionService` is public and that fixer acquisition resolves defaults before calling the atomic accessor operation.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/backend/services/terminal/service/terminal-domain-exports.test.ts src/backend/services/session/service/data/session-data.service.test.ts`

Expected: FAIL for missing APIs.

- [ ] **Step 3: Implement and migrate consumers**

Introduce terminal lifecycle operations around creation, attachment/lookup, deletion, orphan cleanup, and PID recovery rather than exposing accessor-shaped pass-through methods. Move settings-dependent acquisition preparation above the resource layer. Replace raw session/terminal imports in workspace tRPC, ratchet, orchestration, and transports with public intent/invariant APIs.

- [ ] **Step 4: Verify GREEN and scan leakage**

Run focused session, terminal, ratchet fixer, reconciliation, workspace-init, and tRPC tests. Then run `node scripts/check-service-accessor-boundaries.mjs` and verify no session/terminal violations remain.

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/session src/backend/services/terminal src/backend/services/ratchet src/backend/orchestration src/backend/routers src/backend/trpc
git commit -m "Hide session and terminal persistence (#1956)"
```

### Task 5: Add intent-focused workspace APIs and migrate all consumers

**Files:**
- Create: `src/backend/services/workspace/service/query/workspace-maintenance.service.ts`
- Create: `src/backend/services/workspace/service/query/workspace-notification.service.ts`
- Create: `src/backend/services/workspace/service/lifecycle/workspace-auto-iteration.service.ts`
- Create: `src/backend/services/workspace/service/lifecycle/workspace-pr-snapshot.service.ts`
- Create: `src/backend/services/workspace/service/lifecycle/workspace-ratchet.service.ts`
- Create: `src/backend/services/workspace/service/lifecycle/workspace-run-script.service.ts`
- Create: `src/backend/services/workspace/service/lifecycle/workspace-relationships.service.ts`
- Modify: `src/backend/services/workspace/service/lifecycle/creation.service.ts`
- Modify: `src/backend/services/workspace/service/lifecycle/data.service.ts`
- Modify: `src/backend/services/workspace/service/index.ts`
- Modify: `src/backend/services/workspace/service/workspace-domain-exports.test.ts`
- Modify: `src/backend/server.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`
- Modify: `src/backend/orchestration/linear-config.helper.ts`
- Modify: `src/backend/orchestration/reconciliation.service.ts`
- Modify: `src/backend/orchestration/scheduler.service.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Modify: `src/backend/orchestration/types.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-children.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-init-issue-prompts.ts`
- Modify: `src/backend/orchestration/workspace-init.orchestrator.ts`
- Modify: `src/backend/services/github/service/pr-snapshot.service.ts`
- Modify: `src/backend/services/ratchet/service/fixer-session.service.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-active-session.helpers.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-provider-resolver.service.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.types.ts`
- Modify: `src/backend/services/run-script/service/run-script-state-machine.service.ts`
- Modify: `src/backend/services/run-script/service/run-script.service.ts`
- Modify: `src/backend/services/run-script/service/startup-script.service.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers.service.ts`
- Modify: `src/backend/services/session/service/data/session-provider-resolver.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-pr-discovery.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.repository.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.test.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.test.ts`
- Modify: `src/backend/orchestration/workspace-children.orchestrator.test.ts`
- Modify: `src/backend/orchestration/workspace-init.orchestrator.test.ts`
- Modify: `src/backend/services/ratchet/service/fixer-session.service.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-provider-resolver.service.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.test.ts`
- Modify: `src/backend/services/session/service/data/session-provider-resolver.service.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts`
- Modify: `scripts/check-single-writer.mjs`

**Interfaces:**
- Produces: semantic candidate queries, notification delivery, relationship lookup, auto-iteration transitions, PR snapshot writes, ratchet CAS operations, run-script/init operations, and periodic-task workspace creation.

- [ ] **Step 1: Write failing export/use-case tests**

Extend the workspace domain export test and add focused tests for notification ordering, periodic-task creation, and at least one CAS capability from each state-oriented service.

- [ ] **Step 2: Verify RED**

Run the new workspace service tests and confirm they fail for missing services/source variants.

- [ ] **Step 3: Implement minimal intent services and migrate clusters**

Migrate in this order: workspace tRPC; children/notifications; maintenance/reconciliation/scheduler/archive; initialization and periodic creation; GitHub PR snapshot; run-script; ratchet; session workspace lookups; auto-iteration/snapshot orchestration. Do not expose the raw accessor or a generic raw lookup.

- [ ] **Step 4: Update single-writer ownership and verify GREEN**

Run workspace, orchestration, GitHub, run-script, ratchet, and session focused tests. Run `pnpm check:ownership` until both accessor-boundary and field-writer checks pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/workspace src/backend/services/github src/backend/services/ratchet src/backend/services/run-script src/backend/services/session src/backend/orchestration src/backend/trpc src/backend/server.ts scripts/check-single-writer.mjs
git commit -m "Expose workspace use case APIs (#1956)"
```

### Task 6: Remove all raw barrel exports and update integration tests

**Files:**
- Modify: `src/backend/services/workspace/index.ts`
- Modify: `src/backend/services/session/index.ts`
- Modify: `src/backend/services/settings/index.ts`
- Modify: `src/backend/services/terminal/index.ts`
- Modify: `src/backend/services/decision-log/index.ts`
- Modify: `src/backend/services/periodic-task/index.ts`
- Move/Delete: `src/backend/services/resources.integration.test.ts`
- Create/Modify: resource-level integration tests under their owning service capsules.
- Modify: all tests still mocking raw accessor properties on capsule barrels.

**Interfaces:**
- Produces: capsule barrels containing service/type exports only.

- [ ] **Step 1: Make the guard fail on current barrels**

Run: `node scripts/check-service-accessor-boundaries.mjs`

Expected: FAIL listing any remaining raw re-exports/imports.

- [ ] **Step 2: Remove exports and update resource tests**

Integration tests outside an owner capsule exercise public service APIs only. Tests that must import resource modules directly move under the owning capsule. Consumer tests mock public services. Required record types are re-exported deliberately from service modules without accessor values.

- [ ] **Step 3: Verify GREEN**

Run: `node scripts/check-service-accessor-boundaries.mjs`

Run: `pnpm typecheck`

Expected: boundary check and types pass.

- [ ] **Step 4: Commit**

```bash
git add src/backend/services src/backend/orchestration src/backend/trpc src/backend/routers
git commit -m "Remove persistence exports from capsules (#1956)"
```

### Task 7: Full verification, review, and pull request

**Files:**
- Modify only files required to fix verification failures.
- Create: `/tmp/pr-body.md` outside the repository.

**Interfaces:**
- Produces: a clean branch and draft-ready GitHub pull request closing #1956.

- [ ] **Step 1: Run required verification**

```bash
pnpm typecheck && pnpm check:fix && pnpm check && pnpm test && pnpm build
```

Expected: all checks pass. If the two recorded React `act` files still fail unchanged, run all issue-related tests separately, document the verified baseline delta, and do not claim a clean full test run until the baseline problem is resolved or demonstrably environmental.

- [ ] **Step 2: Review and simplify**

Run `git diff origin/main`, scan for raw accessor references outside owner internals, delegate a code-simplifier review because this change exceeds eight files, apply justified simplifications, and rerun affected tests plus the full required command.

- [ ] **Step 3: Commit verification fixes and confirm clean state**

```bash
git status --short
git log --oneline origin/main..HEAD
```

Expected: clean working tree and descriptive commits.

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin HEAD
gh pr create --title "Fix #1956: Hide persistence behind capsule APIs" --body-file /tmp/pr-body.md
gh pr view --json url --jq .url
```

The PR body contains Summary, Changes, Testing, `Closes #1956`, and the required Factory Factory signature as its final lines.
