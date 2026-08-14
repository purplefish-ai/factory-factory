# Session Termination Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AcpRuntimeManager` the sole owner of client-creation quiescence and extract explicit, workspace, and shutdown stop orchestration into `SessionTerminationCoordinator` without changing the public lifecycle API or observable cleanup order.

**Architecture:** A small ACP-layer `AcpRuntimeQuiescence` unit owns tracked client-creation reconciliation operations and idempotent stop-and-quiesce operations. `AcpRuntimeManager` exposes that behavior through `runClientCreationOperation` and `stopAndQuiesce`, while retaining all subprocess maps and stop mechanics. `SessionStartupCoordinator` runs creation through the runtime-owned fence, and a new `SessionTerminationCoordinator` owns the lifecycle stop barrier, durable reasons, cleanup ordering, workspace stops, and bounded shutdown. `SessionLifecycleService` composes both coordinators and delegates its existing public methods.

**Tech Stack:** TypeScript 5.9, Vitest 4, pnpm, Biome, dependency-cruiser.

## Global Constraints

- Preserve the signatures, return values, errors, durable events, logging categories, and side-effect ordering of all existing public lifecycle methods.
- Keep `SessionLifecycleGate` as the sole domain authority for stop/startup eligibility and `AcpRuntimeManager` as the sole owner of runtime creation and quiescence promises.
- The runtime-owned creation fence must span the full startup reconciliation operation through the durable `RUNNING` write; `pendingCreation` alone is not a sufficient stop barrier.
- `stopAndQuiesce` must be idempotent, reject new same-session fenced creation after quiescence begins, wait already-registered operations, retry runtime stop after they settle, and treat a successful retry as authoritative over an earlier stop error.
- Duplicate lifecycle stops must return without releasing the first stop reservation, repeating durable stop events, or running unmanaged-exit finalization.
- Preserve the existing stop cleanup order: prompt/queue fencing, session lookup and durable reason, stopping snapshot, ACP and permission cleanup, runtime quiescence, orphan-tool cleanup, durable idle, stopped snapshot, workspace idle, ACP session clear, deliberate workflow finalization on successful runtime stop, inactive cleanup, and trace close.
- Preserve shutdown admission closure before lifecycle recording, the one-second lifecycle-recording bound, browse-only event omission, and runtime shutdown even when recording fails or times out.
- Keep each new production unit below 600 lines and below the unbaselined 1,000-line limit. Do not increase any tracked file-length baseline; in particular, the separately baselined runtime manager must remain at or below 1,449 lines.
- Import within the session capsule according to `src/backend/services/AGENTS.md`; do not introduce cross-capsule deep imports, cycles, or `await import()`.
- Use TDD for every behavior change. Do not reach private methods from tests; test the public helper, runtime-manager, coordinator, and facade contracts.

---

### Task 1: Establish the runtime-owned client-creation fence

**Files:**
- Create: `src/backend/services/session/service/acp/acp-runtime-quiescence.ts`
- Create: `src/backend/services/session/service/acp/acp-runtime-quiescence.test.ts`
- Modify: `src/backend/services/session/service/acp/acp-runtime-manager.ts`
- Modify: `src/backend/services/session/service/acp/acp-runtime-manager.test.ts`
- Modify: `src/backend/services/session/service/acp/index.ts`

**Interfaces:**
- Produces: `AcpClientCreationOperation`, exposing only `isOnlyOperation(): boolean` to the operation body.
- Produces: `AcpRuntimeQuiescence`, constructed with a typed `stopClient(sessionId)` port.
- Produces on `AcpRuntimeManager`:

  ```ts
  runClientCreationOperation<T>(
    sessionId: string,
    purpose: AcpRuntimePurpose,
    operation: (registration: AcpClientCreationOperation) => Promise<T>
  ): Promise<T>;

  stopAndQuiesce(sessionId: string): Promise<void>;
  ```

- Preserves: `stopClient`, `beginShutdown`, and `stopAllClients` as public compatibility methods.

- [ ] **Step 1: Add public quiescence RED tests**

  In `acp-runtime-quiescence.test.ts`, construct the public helper with a typed `stopClient` spy and add tests proving:

  - `runClientCreationOperation` registers synchronously, exposes `isOnlyOperation()`, returns the operation result, and unregisters on both resolve and reject;
  - concurrent same-session creation operations report the correct only-operation state;
  - `stopAndQuiesce` calls stop immediately, remains pending while an already-registered creation/reconciliation operation is pending, then stops again after it settles;
  - if the first stop rejects and a tracked operation exists, a successful retry resolves; if no tracked operation exists, the original stop error rejects;
  - overlapping `stopAndQuiesce` calls share one operation and do not run duplicate stop sequences;
  - a new same-session creation operation is rejected after quiescence begins, while a different session remains independent.

- [ ] **Step 2: Run the helper suite and capture RED**

  Run:

  ```bash
  pnpm test src/backend/services/session/service/acp/acp-runtime-quiescence.test.ts
  ```

  Expected: FAIL because `./acp-runtime-quiescence` does not exist. No production helper may exist before this failure is captured.

- [ ] **Step 3: Implement the minimal public helper**

  Implement `AcpRuntimeQuiescence` with one session-keyed collection of `{ barrier, purpose }` creation/reconciliation records and one `Map<string, Promise<void>>` for idempotent quiescence calls. Register a deferred barrier before invoking the operation callback and settle/remove it in `finally`. When a same-session quiescence call is active, reject new registration with the existing message `ACP session stop requested; cannot create client ${sessionId}`. Report a tracked session as browse-only only when every live record for it has purpose `browse`.

  Implement `stopAndQuiesce` in this exact order:

  1. synchronously publish the session's quiescence operation;
  2. attempt `stopClient`, retaining any error;
  3. snapshot and await all registered creation barriers;
  4. if no barrier existed, propagate the retained stop error or return;
  5. if a barrier existed, call `stopClient` again and use the retry outcome as authoritative;
  6. clear the quiescence entry in `finally` only when it still refers to this operation.

  Expose read-only `getTrackedSessionIds()`, `isBrowseOnlySession(sessionId)`, and `waitForAll()` methods for shutdown integration. Do not expose the records or a manual `release()` function. `waitForAll()` itself is unbounded; `AcpRuntimeManager.stopAllClients(timeoutMs)` applies the existing soft timeout at the boundary.

- [ ] **Step 4: Add runtime-manager integration RED tests**

  Extend existing public manager tests without increasing `acp-runtime-manager.test.ts` beyond its 2,714-line ceiling. Rework an existing pending-creation stop case to run a deferred post-creation reconciliation through `runClientCreationOperation`, call `stopAndQuiesce`, and assert that:

  - the first stop cannot finish the public quiescence operation while reconciliation is pending;
  - a runtime installed by the operation is stopped by the retry;
  - `getClient(sessionId)` is undefined when `stopAndQuiesce` resolves;
  - two callers receive the same idempotent stop outcome.

  Add or amend a shutdown case so `beginShutdown()` reports sessions known only to the creation fence and `stopAllClients()` waits those fences before its final process-stop pass.

- [ ] **Step 5: Wire the helper into `AcpRuntimeManager`**

  Construct one helper inside `AcpRuntimeManager`, delegate the two new public methods, include `getTrackedSessionIds()` in `beginShutdown()`, and include the helper's purpose classification in `isBrowseOnlySession()`. Insert `raceWithSoftTimeout(quiescence.waitForAll(), timeoutMs)` between the first and final `stopCurrentClients()` passes in `stopAllClients()`.

  Keep `stopClientOnce`, process cancellation, incarnation filtering, creation locks, and `pendingCreation` unchanged. If the 1,449-line manager would grow, extract delegation or shutdown mechanics into the new helper or compact behavior-neutral code; do not raise the baseline.

- [ ] **Step 6: Run Task 1 GREEN**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/acp/acp-runtime-quiescence.test.ts \
    src/backend/services/session/service/acp/acp-runtime-manager.test.ts
  pnpm typecheck
  ```

  Expected: both suites pass, TypeScript reports no diagnostics, the manager remains at or below 1,449 lines, and the manager test remains at or below 2,714 lines.

- [ ] **Step 7: Commit the runtime contract**

  Inspect the Task 1 diff and commit it with subject `Own runtime creation quiescence`.

---

### Task 2: Move startup reconciliation onto the runtime-owned fence

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-lifecycle.test-helpers.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts`

**Interfaces:**
- Removes: `ClientCreationRegistration` and `registerClientCreation` from `SessionStartupCoordinatorDependencies`.
- Consumes: `AcpRuntimeManager['runClientCreationOperation']` through the startup coordinator's typed runtime-manager port.
- Removes: facade-owned `clientCreationOperations`, `registerClientCreation`, and `stopRuntimeAndPendingCreation`.

- [ ] **Step 1: Add startup/runtime integration RED tests**

  In `session-startup.coordinator.test.ts`, update the typed runtime-manager fixture with `runClientCreationOperation` and add a public test whose runtime handle resolves before `repository.updateSession(...RUNNING)` does. Start the coordinator operation, reserve a stop, and assert that the runtime-owned creation operation remains pending until the durable write settles and then surfaces the existing startup cancellation result.

  In `session-termination.coordinator.test.ts`, change the pending-start race expectation from two calls to `stopClient` to one call to `stopAndQuiesce`, while preserving the assertions that the stop waits, the resulting runtime is absent, and no prompt is sent.

- [ ] **Step 2: Run focused RED**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts
  ```

  Expected: FAIL because startup still uses the injected facade registration port and termination still calls facade-owned stop/retry logic.

- [ ] **Step 3: Replace the transitional startup tracker**

  Add `runClientCreationOperation` to the startup coordinator's `runtimeManager` pick. Replace both calls to the private `runTrackedClientCreation` with:

  ```ts
  return await this.dependencies.runtimeManager.runClientCreationOperation(
    sessionId,
    purpose,
    async (registration) => {
      // Existing creation, configuration, notification recovery,
      // durable RUNNING reconciliation, and snapshots remain here unchanged.
    }
  );
  ```

  Pass literal `browse` from `ensureSubagentBrowseSession` and literal `active` from active get-or-create. Delete the startup coordinator's deferred-barrier wrapper and transitional dependency. Preserve `registration.isOnlyOperation()` for ACP state cleanup on failure.

- [ ] **Step 4: Remove the facade's parallel authority**

  Delete `clientCreationOperations`, `registerClientCreation`, and `stopRuntimeAndPendingCreation` from `SessionLifecycleService`. Temporarily call `runtimeManager.stopAndQuiesce(sessionId)` from the existing stop body until Task 3 moves that body into the coordinator.

  Update `session-lifecycle.test-helpers.ts` so its typed runtime-manager mock implements `runClientCreationOperation` by immediately invoking the callback with an `isOnlyOperation: () => true` registration and exposes `stopAndQuiesce`. Do not emulate a second promise registry in the fixture.

- [ ] **Step 5: Run Task 2 GREEN**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/acp/acp-runtime-quiescence.test.ts \
    src/backend/services/session/service/acp/acp-runtime-manager.test.ts \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.service.test.ts
  pnpm typecheck
  ```

  Expected: all focused tests pass, startup remains below 600 lines, and `rg "clientCreationOperations|registerClientCreation" src/backend/services/session` returns no matches.

- [ ] **Step 6: Commit the ownership migration**

  Inspect the Task 2 diff and commit it with subject `Move startup fences into the runtime`.

---

### Task 3: Extract explicit and workspace stop orchestration

**Files:**
- Create: `src/backend/services/session/service/lifecycle/session-termination.coordinator.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-lifecycle.test-helpers.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.ts`

**Interfaces:**
- Produces: `SessionStopReason` and `StopSessionOptions` from `session-termination.coordinator.ts`, re-exported by the facade to keep current import paths valid.
- Produces: `SessionTerminationCoordinator` with public methods:

  ```ts
  stopSession(sessionId: string, options?: StopSessionOptions): Promise<void>;
  stopWorkspaceSessions(
    workspaceId: string,
    options?: { reason?: SessionStopReason }
  ): Promise<void>;
  ```

- Consumes: explicit typed ports for repository, retry, runtime, domain, permission, ACP cleanup, prompt completion, lifecycle event/gate, workflow finalization, workspace bridge lookup, and optional pre-stop callback.

- [ ] **Step 1: Convert termination tests to the public coordinator and capture RED**

  Import `SessionTerminationCoordinator` directly and build a narrow typed termination harness rather than constructing the full lifecycle service. Move the existing workspace-stop, stop-cause, and race characterizations to that public class. Add explicit ordering assertions for:

  - `reserveStop` occurring synchronously before session loading;
  - the durable lifecycle event completing before `stopAndQuiesce` begins;
  - mandatory cleanup continuing when runtime stop fails, while deliberate workflow finalization is skipped;
  - cleanup steps retaining their current order and the reservation releasing in the outer `finally`;
  - duplicate stops returning early without a second durable event, runtime stop, cleanup, or barrier release;
  - workspace stop attempting every eligible persisted, runtime-only, and browse-only session and aggregating failures.

- [ ] **Step 2: Run the direct suite and capture RED**

  Run:

  ```bash
  pnpm test src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts
  ```

  Expected: FAIL because `./session-termination.coordinator` does not exist.

- [ ] **Step 3: Move explicit stop behavior without semantic edits**

  Move the existing `stopSession`, stop body, workspace selection, best-effort session loading, durable idle update, orphan-tool finalization, and workspace-idle reconciliation into the coordinator. Use `runtimeManager.stopAndQuiesce(sessionId)` as the only runtime stop call.

  Keep the stop reservation acquisition in the coordinator's synchronous method prefix and release it only in `finally`. Keep the random durable stop invocation ID per accepted stop. Preserve the existing error precedence: runtime stop failure is logged and cleanup continues; deliberate workflow finalization runs only after successful runtime quiescence; independent cleanup failures retain their current propagate-or-log behavior.

- [ ] **Step 4: Delegate from the compatibility facade**

  Construct one `SessionTerminationCoordinator` beside the startup and runtime-exit coordinators. Supply the workspace bridge through `getWorkspaceBridge: () => this.workspaceBridge` so later `configure()` calls update the same composed instance without reconstructing it.

  Replace facade `stopSession` and `stopWorkspaceSessions` bodies with argument-preserving delegation. Re-export the moved stop types from `session.lifecycle.service.ts`. Point `SessionStartupCoordinator`'s restart-stop callback at the coordinator-backed facade method so restart behavior remains stable.

- [ ] **Step 5: Add facade delegation RED/GREEN coverage**

  In `session.lifecycle.facade.test.ts`, spy on the two `SessionTerminationCoordinator` public methods and assert that the facade forwards exact session IDs, workspace IDs, options, results, and rejections. Do not assert coordinator internals in the facade suite. `stopAllClients` remains on the facade until Task 4.

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.service.test.ts
  ```

  Expected: all focused suites pass with unchanged facade behavior.

- [ ] **Step 6: Commit the explicit-stop extraction**

  Inspect the Task 3 diff and commit it with subject `Extract session termination coordinator`.

---

### Task 4: Move bounded shutdown policy and verify the complete PR

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session-termination.coordinator.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-services.composition.test.ts`
- Modify: `scripts/file-length-baseline.json`
- Modify: only files listed above if verification exposes an extraction regression

**Interfaces:**
- Preserves: `SessionLifecycleService.stopAllClients(timeoutMs = 5000)` and `AcpRuntimeManager.stopAllClients(timeoutMs = 5000)`.
- Adds: `SessionTerminationCoordinator.stopAllClients(timeoutMs = 5000)` and delegates the existing facade method to it.
- Produces: one fully composed termination coordinator using the same lifecycle gate, runtime manager, workflow finalizer, and mutable workspace-bridge seam as the facade.

- [ ] **Step 1: Add direct shutdown RED tests**

  Move graceful-shutdown tests onto the public coordinator and add coverage proving:

  - prompt completion clears before `beginShutdown`;
  - `beginShutdown` atomically closes runtime admission before any durable event await;
  - shutdown reserves the lifecycle gate only for non-browse sessions;
  - active, pending, and creation-fenced sessions receive `SYSTEM_STOP`, while browse-only sessions do not;
  - lifecycle recording failures are logged independently and do not skip runtime shutdown;
  - the one-second recording timeout is cleared on early completion and allows shutdown to continue on expiry;
  - caller timeout is forwarded unchanged and runtime shutdown rejection still propagates after logging.

- [ ] **Step 2: Run focused RED**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts
  ```

  Expected: at least one direct shutdown or facade delegation assertion fails until shutdown ownership is fully moved.

- [ ] **Step 3: Complete shutdown extraction and composition coverage**

  Move shutdown event recording, timeout handling, and runtime shutdown invocation into `SessionTerminationCoordinator.stopAllClients`. Replace the facade method with a direct delegate.

  In `session-services.composition.test.ts`, assert the public lifecycle singleton uses one fully configured termination coordinator and that the workspace bridge attached through `configure()` is observed by a later stop. Do not export the coordinator from the capsule barrel; callers continue through `SessionLifecycleService`.

- [ ] **Step 4: Run focused lifecycle and runtime GREEN**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/acp/acp-runtime-quiescence.test.ts \
    src/backend/services/session/service/acp/acp-runtime-manager.test.ts \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-runtime-exit.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts \
    src/backend/services/session/service/lifecycle/session-services.composition.test.ts \
    src/backend/services/session/service/lifecycle/session.service.test.ts
  ```

  Expected: all focused suites pass. Managed stops do not invoke unmanaged-exit finalization, and all public lifecycle signatures remain unchanged.

- [ ] **Step 5: Format, ratchet file sizes, and inspect the baseline**

  Run:

  ```bash
  pnpm check:fix
  pnpm check:file-length:update
  git diff -- scripts/file-length-baseline.json
  wc -l \
    src/backend/services/session/service/acp/acp-runtime-quiescence.ts \
    src/backend/services/session/service/acp/acp-runtime-manager.ts \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.ts \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.ts \
    src/backend/services/session/service/lifecycle/session.lifecycle.service.ts
  ```

  Expected: every new focused production file is below 600 lines; the facade ceiling decreases; the ACP manager does not exceed 1,449 lines; no recorded ceiling increases.

- [ ] **Step 6: Run the complete handoff sequence**

  Run sequentially on the final formatted tree:

  ```bash
  pnpm check:fix
  pnpm typecheck
  pnpm test --maxWorkers=2
  pnpm check
  ```

  Expected: every command exits 0. `pnpm check:prisma-schema` is not required because this PR must not alter `prisma/schema.prisma`.

- [ ] **Step 7: Perform final ownership and behavior review**

  Run:

  ```bash
  rg "clientCreationOperations|registerClientCreation|stopRuntimeAndPendingCreation" src/backend/services/session
  git diff --check
  git status --short
  ```

  Expected: the ownership search returns no matches, `git diff --check` is clean, and status contains only intended PR files. Review the exact base-to-head diff for stop ordering, error precedence, barrier release, retry authority, shutdown timeout cleanup, capsule imports, and public signature preservation.

- [ ] **Step 8: Commit and prepare the pull request**

  Commit the final extraction with subject `Complete termination coordinator wiring`. After PR #2178 merges, rebase this branch onto current `origin/main`, rerun the complete handoff sequence, then use the finishing workflow to push and open the PR. The PR body must state the ownership change, why the runtime fence spans durable startup reconciliation, the unchanged public API, the downward file-length ratchet, and the exact checks run.
