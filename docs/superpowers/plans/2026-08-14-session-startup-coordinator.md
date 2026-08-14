# Session Startup Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract active, restart, get-or-create, and browse startup from `SessionLifecycleService` into a focused `SessionStartupCoordinator` without changing the public lifecycle API or observable behavior.

**Architecture:** `SessionLifecycleService` remains the compatibility facade and delegates startup methods to one coordinator. The coordinator owns startup leases, context and preset resolution, ACP construction inputs, runtime/config snapshots, browse probing, and notification recovery. The facade temporarily retains the client-creation operation tracker used by stop cleanup through a narrow registration port; PR 8 will replace that tracker with the runtime manager's strengthened quiescence contract.

**Tech Stack:** TypeScript 5.9, Vitest 4, pnpm, Biome, dependency-cruiser.

## Global Constraints

- Preserve the signatures, return values, errors, persistence effects, and ordering of all existing public lifecycle methods.
- Validate the startup lease after every asynchronous boundary at which a stop can invalidate work.
- Do not move stop orchestration or strengthen runtime quiescence in this PR.
- Do not add runtime creation deduplication or process-handle state outside `AcpRuntimeManager`.
- Keep `SessionStartupCoordinator` below 600 lines and every production file below 1,000 lines.
- Import within the session capsule according to `src/backend/services/AGENTS.md`; do not introduce cross-capsule deep imports or cycles.
- Use TDD for production changes and lower, never increase, tracked file-length baselines.

---

### Task 1: Define and characterize the public startup coordinator

**Files:**
- Create: `src/backend/services/session/service/lifecycle/session-startup.coordinator.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-lifecycle.test-helpers.ts`

**Interfaces:**
- Produces: `SessionStartupCoordinator` with public methods `startSession`, `restartSession`, `getOrCreateSessionClient`, `getOrCreateSessionClientFromRecord`, and `ensureSubagentBrowseSession`.
- Produces: `SessionStartupCoordinatorDependencies`, including explicit repository, context, environment, runtime, domain, configuration, event-handler, lifecycle-gate, notification, prompt-send, message-dispatch, restart-stop, and transitional creation-registration ports.
- Consumes: existing `StartSessionOptions`, `GetOrCreateSessionClientOptions`, `AgentSessionRecord`, and `SessionLifecycleGate` contracts.

- [ ] **Step 1: Add a direct public-class characterization test**

  Import `SessionStartupCoordinator` from `./session-startup.coordinator`, construct it with typed test ports, call `getOrCreateSessionClient('session-1')`, and assert the returned handle plus the literal persisted `RUNNING` transition and runtime snapshot. The production mutation this test catches is a coordinator that creates a client but fails to reconcile durable and in-memory running state.

- [ ] **Step 2: Run the direct suite and capture RED**

  Run: `pnpm test src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts`

  Expected: FAIL because `./session-startup.coordinator` does not exist. No production file may exist before this failure is captured.

- [ ] **Step 3: Add the minimal coordinator contract and typed dependencies**

  Create the class and constructor with this public surface:

  ```ts
  export class SessionStartupCoordinator {
    constructor(dependencies: SessionStartupCoordinatorDependencies);

    startSession(sessionId: string, options?: StartSessionOptions): Promise<void>;
    restartSession(sessionId: string, options?: StartSessionOptions): Promise<void>;
    getOrCreateSessionClient(
      sessionId: string,
      options?: GetOrCreateSessionClientOptions
    ): Promise<unknown>;
    getOrCreateSessionClientFromRecord(
      session: AgentSessionRecord,
      options?: GetOrCreateSessionClientOptions
    ): Promise<unknown>;
    ensureSubagentBrowseSession(sessionId: string): Promise<boolean>;
  }
  ```

  Implement only enough get-or-create behavior to make the new direct test pass, using a real `SessionLifecycleGate` and typed injected ports.

- [ ] **Step 4: Run GREEN and retain the existing facade characterizations**

  Run: `pnpm test src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts`

  Expected: PASS. Existing startup behavior tests must remain present; migrate their harness target from the facade only when the test can exercise the real public coordinator without broad mock assertions.

---

### Task 2: Move active, restart, and get-or-create startup behind the coordinator

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-lifecycle.test-helpers.ts`

**Interfaces:**
- Consumes: a narrow creation registration port that returns `isOnlyOperation()` and `release()` for the facade-owned `clientCreationOperations` map.
- Consumes: a restart-stop callback with the existing `stopSession(sessionId, { cleanupTransientRatchetSession: false })` behavior.
- Produces: facade methods that delegate unchanged arguments and results to the coordinator.

- [ ] **Step 1: Add RED delegation and boundary tests**

  Add public tests that fail if the facade implements startup itself instead of delegating, and direct coordinator cases for stop invalidation after session lookup, permission resolution, client creation, configuration snapshot persistence, notification recovery, preset application, queued dispatch, and initial prompt completion. Each test must assert the consumer-visible cancellation or absence of a later `RUNNING` write.

- [ ] **Step 2: Run the focused suites and verify the expected failures**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts
  ```

  Expected: FAIL because facade delegation and the moved coordinator behavior are incomplete.

- [ ] **Step 3: Move startup implementation without semantic edits**

  Move these responsibilities into `SessionStartupCoordinator`:

  - `startSession` and `restartSession`;
  - both get-or-create entry points;
  - ACP client option construction and event-handler creation;
  - permission/startup preset application;
  - reasoning effort, config snapshot, and capability delta application;
  - notification recovery and best-effort queued dispatch;
  - runtime snapshot transitions and the durable `RUNNING` reconciliation point.

  Keep the facade-owned creation tracker accessible only through a narrow port so `stopRuntimeAndPendingCreation` remains unchanged for PR 8. Preserve every existing `assertStartupAllowed` check and add checks only where the approved race matrix already requires one.

- [ ] **Step 4: Replace facade bodies with delegation**

  Construct exactly one coordinator after notification delivery is configured, forward the existing message-queue bridge into it, and delegate the five startup public methods. Keep `getSessionClient`, runtime snapshot reads, lifecycle-gate queries, stop methods, and workflow-finalizer methods on the facade.

- [ ] **Step 5: Run focused GREEN**

  Run the two-file command from Step 2 plus:

  ```bash
  pnpm test src/backend/services/session/service/lifecycle/session.service.test.ts
  ```

  Expected: all focused tests pass with unchanged public behavior.

---

### Task 3: Move browse startup and verify composition

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-services.composition.test.ts`
- Modify: `src/backend/services/session/service/lifecycle/session-core-services.ts` only if constructor wiring requires it
- Modify: `src/backend/services/session/service/lifecycle/session-services.ts` only if notification/message-queue configuration forwarding requires it

**Interfaces:**
- Produces: browse startup that returns the existing boolean contract and never marks a browse-only runtime `RUNNING`, recovers notifications, or persists a provider session ID.
- Preserves: one public lifecycle singleton and one coordinator instance before chat transport uses the facade.

- [ ] **Step 1: Add RED browse and composition assertions**

  Characterize stored-provider-session requirements, unusable worktrees, unsupported restore, unsupported capability cleanup, active promotion, concurrent browse cleanup, and cancellation translation to `false`. Add a composition assertion that the public singleton is fully startup-configured before chat dispatch calls it.

- [ ] **Step 2: Run RED**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-services.composition.test.ts
  ```

  Expected: at least one new direct coordinator or composition assertion fails before browse wiring is complete.

- [ ] **Step 3: Move browse behavior and cancellation translation**

  Move `ensureSubagentBrowseSession` and browse support resolution into the coordinator. Preserve the existing `AcpBrowseSessionUnavailableError` and `SessionStartupCancelledError` translations, the stop reservation around unsupported browse cleanup, and the rule that browse handlers omit provider-session persistence.

- [ ] **Step 4: Run focused lifecycle GREEN**

  Run:

  ```bash
  pnpm test \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-runtime-exit.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-services.composition.test.ts \
    src/backend/services/session/service/lifecycle/session.service.test.ts
  ```

  Expected: all focused suites pass.

---

### Task 4: Ratchet file sizes and complete repository verification

**Files:**
- Modify: `scripts/file-length-baseline.json`
- Modify: only files already listed above if verification exposes an extraction regression

**Interfaces:**
- Produces: no public API change; only lower file ceilings and verified behavior.

- [ ] **Step 1: Format and update the downward baseline**

  Run:

  ```bash
  pnpm check:fix
  pnpm check:file-length:update
  git diff -- scripts/file-length-baseline.json
  ```

  Expected: the lifecycle facade ceiling decreases, no ceiling increases, and the new coordinator remains below 600 lines.

- [ ] **Step 2: Run type and focused verification**

  Run:

  ```bash
  pnpm typecheck
  pnpm test \
    src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session.lifecycle.facade.test.ts \
    src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-runtime-exit.coordinator.test.ts \
    src/backend/services/session/service/lifecycle/session-services.composition.test.ts \
    src/backend/services/session/service/lifecycle/session.service.test.ts
  ```

  Expected: exit 0 with no TypeScript diagnostics or test failures.

- [ ] **Step 3: Run the complete handoff sequence**

  Run:

  ```bash
  pnpm check:fix
  pnpm typecheck
  pnpm test --maxWorkers=2
  pnpm check
  ```

  Expected: every command exits 0. `pnpm check:prisma-schema` is not required because this PR must not alter `prisma/schema.prisma`.

- [ ] **Step 4: Review and commit**

  Inspect `git diff --check`, the exact base-to-head diff, file sizes, imports, public signatures, and startup-boundary assertions. Commit with an imperative subject under 72 characters, then use the finishing workflow to push and open the PR with the checks recorded in its body.
