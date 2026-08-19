# ACP Runtime Manager Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1,449-line `AcpRuntimeManager` implementation with a stable compatibility facade over one state-owning supervisor and focused ACP collaborators, while splitting its 2,705-line test and preserving observable behavior.

**Architecture:** `AcpRuntimeSupervisor` becomes the sole owner of installed handles, pending creation, purpose/incarnation metadata, stop state, exit fences, and quiescence. A stateless client factory, prompt controller, runtime configuration controller, and sub-agent browser perform handle-scoped work; `AcpRuntimeManager` constructs the graph and preserves every existing caller-facing method.

**Tech Stack:** Node.js `^22.22 || >=24`, TypeScript 5.9, pnpm 10, Vitest 4, Agent Client Protocol SDK, Zod 4.

**Spec:** `docs/superpowers/specs/2026-08-19-acp-runtime-manager-modularization-design.md`

## Global Constraints

- Use pnpm only; never use npm or yarn.
- Preserve the existing `AcpRuntimeManager` constructor and public method signatures.
- Preserve `PromptTimeoutError`, `AcpBrowseSessionUnavailableError`, and `AcpRuntimeCreatedCallback` import identity through re-exports from `acp-runtime-manager.ts`; preserve existing error names and messages.
- Do not export internal collaborators from `service/acp/index.ts` or a session capsule barrel.
- Only `AcpRuntimeSupervisor` may own or mutate cross-session runtime registries after Stage 5.
- Stateless controllers may mutate protocol-local fields only on the supplied handle and may not retain handles.
- Domain eligibility and durable reconciliation remain in session lifecycle coordinators.
- Every new source and test file must stay below 1,000 physical lines and should target 600 lines or fewer.
- Preserve ACP events, callback ordering, public errors, process signals, timeout values, and asserted logs.
- Fix an exposed concurrency defect only when a documented invariant requires it; add a regression test and call it out separately.
- Do not add `await import()`, new public barrel exports, direct `process.env` reads, or database access.
- Run `pnpm check:file-length:update` after intentional reductions; never bless growth.
- Each PR stage runs `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, and `pnpm check`.

---

## File Structure

**Create:**

- `src/backend/services/session/service/acp/acp-runtime-errors.ts`: runtime error classes and error metadata helpers.
- `src/backend/services/session/service/acp/acp-subagent-browser.ts` and `.test.ts`: stateless sub-agent extension operations.
- `src/backend/services/session/service/acp/acp-runtime-config-controller.ts` and `.test.ts`: live handle-scoped configuration.
- `src/backend/services/session/service/acp/acp-prompt-controller.ts` and `.test.ts`: prompts, cancellation, deadlines, escalation.
- `src/backend/services/session/service/acp/acp-runtime-contracts.ts`: internal metadata, context, signal, and process snapshot types.
- `src/backend/services/session/service/acp/acp-client-factory.ts` and `.test.ts`: spawn and ACP negotiation.
- `src/backend/services/session/service/acp/acp-runtime-supervisor.ts`: sole runtime state/lifecycle authority.
- `src/backend/services/session/service/acp/acp-runtime-supervisor.creation.test.ts` and `.termination.test.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.test-harness.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.creation.test.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.browsing.test.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.termination.test.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.prompt.test.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.config.test.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.facade.test.ts`.

**Modify:**

- `src/backend/services/session/service/acp/acp-runtime-manager.ts`.
- `src/backend/services/session/service/acp/acp-runtime-manager.test-helpers.ts`.
- `src/backend/services/session/service/acp/acp-client-handler.test.ts`.
- `src/backend/services/session/service/acp/acp-runtime-error-handler.ts`.
- `src/backend/services/session/service/acp/index.ts` only to preserve existing exports if import locations move.
- `src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts` for error-identity coverage.
- `src/backend/services/session/service/acp/acp-session-negotiation.integration.test.ts` for public-manager integration coverage.
- `docs/architecture/agent-runtime.md`.
- `scripts/file-length-baseline.json`.

**Delete:**

- `src/backend/services/session/service/acp/acp-runtime-manager.test.ts` after its tests are relocated.

## Stage and PR Boundaries

| PR stage | Tasks | Merge criterion |
| --- | --- | --- |
| 1. Characterization tests | 1 | Split suites pass; original test baseline entry removed |
| 2. Sub-agent browsing | 2 | Manager browse API delegates without behavior change |
| 3. Prompt and configuration | 3–4 | Both controllers are handle-scoped; manager contracts pass |
| 4. Client factory | 5 | Manager retains installation but delegates spawn/negotiation |
| 5. Runtime supervisor | 6–7 | Supervisor is the single state writer; concurrency matrix passes |
| 6. Facade audit | 8 | Manager is below roughly 600 lines and leaves the baseline |

Do not start a later PR stage until the prior stage is merged or the execution branch is rebased onto the accepted stage. Tasks sharing a stage may be separate commits on that stage branch.

---

### Task 1: Split and strengthen manager characterization tests

**PR stage:** 1

**Files:**
- Create: the six `acp-runtime-manager.*.test.ts` files and `acp-runtime-manager.test-harness.ts` listed above.
- Modify: `acp-runtime-manager.test-helpers.ts`, `acp-client-handler.test.ts`, `scripts/file-length-baseline.json`.
- Delete: `acp-runtime-manager.test.ts`.

**Interfaces:**
- Produces: `MockChildProcess`, `createMockChildProcess()`, `createTestProcessHandle()`, `exitChildAfterSigterm()`, and `defaultHandlers()`.
- Produces: one shared Vitest mock graph for spawn, SDK connection, streams, and logger calls.
- Preserves: every public manager assertion, except three private probes replaced by public outcomes.

- [ ] **Step 1: Record the green baseline**

Run:

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-manager.test.ts src/backend/services/session/service/acp/acp-client-handler.test.ts
```

Expected: both files pass before relocation.

- [ ] **Step 2: Move reusable fixtures into the helper module**

Add:

```ts
export type MockChildProcess = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
};

export function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = 12_345;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    if (signal) child.killed = true;
    if (signal === 'SIGKILL') {
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
    }
    return true;
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

export function exitChildAfterSigterm(child: MockChildProcess): void {
  child.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGTERM') {
      queueMicrotask(() => {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      });
    }
    return true;
  });
}

export function createTestProcessHandle(params?: {
  provider?: string;
  providerSessionId?: string;
  agentCapabilities?: Record<string, unknown>;
  connection?: Partial<ClientSideConnection>;
}): AcpProcessHandle {
  return new AcpProcessHandle({
    connection: unsafeCoerce<ClientSideConnection>(params?.connection ?? {}),
    child: unsafeCoerce<ChildProcess>(createMockChildProcess()),
    provider: params?.provider ?? 'CODEX',
    providerSessionId: params?.providerSessionId ?? 'provider-session-1',
    agentCapabilities: params?.agentCapabilities ?? {},
  });
}
```

Move `defaultHandlers()` unchanged. Import `ChildProcess`, `EventEmitter`, `PassThrough`, `ClientSideConnection`, `vi`, `unsafeCoerce`, `AcpProcessHandle`, and `AcpRuntimeEventHandlers` explicitly.

- [ ] **Step 3: Create the shared mock harness**

Move the existing `vi.hoisted` mock state and `vi.mock` declarations into `acp-runtime-manager.test-harness.ts`. Export named mocks and:

```ts
export type ManagerTestHarness = {
  manager: AcpRuntimeManager;
  setupSuccessfulSpawn(agentCapabilities?: Record<string, unknown>): MockChildProcess;
};

export function createManagerTestHarness(): ManagerTestHarness {
  return { manager: new AcpRuntimeManager(), setupSuccessfulSpawn };
}
```

The harness imports/re-exports the manager only after its mock declarations so every split suite uses the same mocked module graph.

- [ ] **Step 4: Relocate describe blocks exactly**

Use this mapping and preserve each test name and expectation:

```text
getOrCreateClient                         -> acp-runtime-manager.creation.test.ts
sub-agent browsing extensions            -> acp-runtime-manager.browsing.test.ts
stopClient + stopAllClients               -> acp-runtime-manager.termination.test.ts
PromptTimeoutError + sendPrompt + cancel  -> acp-runtime-manager.prompt.test.ts
setConfigOption + setSessionMode + model  -> acp-runtime-manager.config.test.ts
session status methods                    -> acp-runtime-manager.facade.test.ts
AcpClientHandler                          -> acp-client-handler.test.ts
```

- [ ] **Step 5: Replace private probes with public outcomes**

For creation-lock bookkeeping, prove duplicate stop identity and successful replacement:

```ts
const firstStop = manager.stopClient('session-1');
const duplicateStop = manager.stopClient('session-1');
expect(duplicateStop).toBe(firstStop);
await firstStop;
harness.setupSuccessfulSpawn();
await expect(manager.getOrCreateClient('session-1', defaultOptions(), defaultHandlers(), defaultContext())).resolves.toBeDefined();
expect(mockSpawn).toHaveBeenCalledTimes(2);
```

For stale prompt timeout replacement, remove the old handle through its real exit event:

```ts
firstChild.exitCode = 1;
firstChild.emit('exit', 1, null);
await vi.waitFor(() => expect(manager.getClient('session-1')).toBeUndefined());
const replacement = await manager.getOrCreateClient('session-1', defaultOptions(), defaultHandlers(), defaultContext());
```

Call public `manager.beginShutdown()` directly instead of type-casting it.

- [ ] **Step 6: Run split suites before deleting the original**

Run:

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-manager.creation.test.ts src/backend/services/session/service/acp/acp-runtime-manager.browsing.test.ts src/backend/services/session/service/acp/acp-runtime-manager.termination.test.ts src/backend/services/session/service/acp/acp-runtime-manager.prompt.test.ts src/backend/services/session/service/acp/acp-runtime-manager.config.test.ts src/backend/services/session/service/acp/acp-runtime-manager.facade.test.ts src/backend/services/session/service/acp/acp-client-handler.test.ts
```

Expected: all relocated and replacement public-contract tests pass.

- [ ] **Step 7: Delete the original and lower the baseline**

Run:

```bash
pnpm check:file-length:update
pnpm check:file-length
git diff -- scripts/file-length-baseline.json
```

Expected: the deleted test entry and legitimate downward counts are removed/lowered; no count increases.

- [ ] **Step 8: Verify and commit Stage 1**

Run `pnpm check:fix`, `pnpm typecheck`, `pnpm test`, `pnpm check`, and `git diff --check` in order.

```bash
git add src/backend/services/session/service/acp scripts/file-length-baseline.json
git commit -m "Split ACP runtime manager tests"
```

---

### Task 2: Extract sub-agent browsing and shared runtime errors

**PR stage:** 2

**Files:**
- Create: `acp-runtime-errors.ts`, `acp-subagent-browser.ts`, `acp-subagent-browser.test.ts`.
- Modify: `acp-runtime-manager.ts`.
- Test: manager browsing and startup coordinator suites.

**Interfaces:**
- Produces: `getAcpErrorLogDetails(error: unknown): AcpErrorLogDetails` and `isMethodNotFoundError(error: unknown): boolean`.
- Produces: existing public error classes from `acp-runtime-errors.ts`, re-exported by the manager.
- Produces: handle-per-call browser methods.

- [ ] **Step 1: Write direct browser tests**

Start with:

```ts
const browser = new AcpSubagentBrowser();
const extMethod = vi.fn().mockResolvedValue({ subagents: [], nextCursor: null });
const handle = createTestProcessHandle({
  providerSessionId: 'provider-session-1',
  agentCapabilities: subagentBrowseCapabilities(),
  connection: { extMethod },
});

await expect(browser.listSubagents(handle, { cursor: null, limit: 20 })).resolves.toEqual({ subagents: [], nextCursor: null });
expect(extMethod).toHaveBeenCalledWith(SUBAGENTS_LIST_METHOD, { sessionId: 'provider-session-1', cursor: null, limit: 20 });
```

Also cover no handle, missing capability, invalid input, invalid response, provider codes `-32602`, `-32002`, `-32601`, `-32000`, protocol errors, unknown errors, and transcript success.

- [ ] **Step 2: Run the direct test and verify RED**

```bash
pnpm test src/backend/services/session/service/acp/acp-subagent-browser.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Create shared runtime errors**

Move the existing classes and metadata normalization exactly:

```ts
export class PromptTimeoutError extends Error {
  constructor(sessionId: string, public readonly timeoutMs: number) {
    super(`ACP prompt timed out after ${timeoutMs}ms for session ${sessionId}`);
    this.name = 'PromptTimeoutError';
  }
}

export class AcpBrowseSessionUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcpBrowseSessionUnavailableError';
  }
}

export type AcpSubagentBrowseErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL_ERROR';

export class AcpSubagentBrowseError extends Error {
  constructor(
    public readonly code: AcpSubagentBrowseErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AcpSubagentBrowseError';
  }
}

export type AcpErrorLogDetails = { message: string; code?: number | string; data?: unknown };
export function getAcpErrorLogDetails(error: unknown): AcpErrorLogDetails;
export function isMethodNotFoundError(error: unknown): boolean;
```

Keep JSON-stringification fallback and code/data narrowing unchanged. Re-export both public classes from `acp-runtime-manager.ts`; do not widen a barrel.

- [ ] **Step 4: Implement the stateless browser**

Use:

```ts
export class AcpSubagentBrowser {
  getCapability(handle: AcpProcessHandle | undefined): SubagentBrowseCapability | null;
  listSubagents(handle: AcpProcessHandle | undefined, input: Omit<SubagentListParams, 'sessionId'>): Promise<SubagentListResult>;
  readSubagentTranscript(handle: AcpProcessHandle | undefined, input: Omit<SubagentReadParams, 'sessionId'>): Promise<SubagentReadResult>;
}
```

Move existing schemas, method names, normalized codes, and messages unchanged. Missing handle rejects before capability inspection.

- [ ] **Step 5: Delegate manager browse methods**

```ts
getSubagentBrowseCapability(sessionId: string) {
  return this.subagentBrowser.getCapability(this.getBrowseClient(sessionId));
}

listSubagents(sessionId: string, input: Omit<SubagentListParams, 'sessionId'>) {
  return this.subagentBrowser.listSubagents(this.getBrowseClient(sessionId), input);
}

readSubagentTranscript(sessionId: string, input: Omit<SubagentReadParams, 'sessionId'>) {
  return this.subagentBrowser.readSubagentTranscript(this.getBrowseClient(sessionId), input);
}
```

- [ ] **Step 6: Verify focused behavior and commit Stage 2**

```bash
pnpm test src/backend/services/session/service/acp/acp-subagent-browser.test.ts src/backend/services/session/service/acp/acp-runtime-manager.browsing.test.ts src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts
pnpm typecheck
pnpm check:fix
pnpm test
pnpm check
git diff --check
```

```bash
git add src/backend/services/session/service/acp src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts
git commit -m "Extract ACP subagent browsing"
```

---

### Task 3: Extract live runtime configuration

**PR stage:** 3

**Files:**
- Create: `acp-runtime-config-controller.ts`, `acp-runtime-config-controller.test.ts`.
- Modify: `acp-runtime-manager.ts`.
- Test: `acp-runtime-manager.config.test.ts`.

**Interfaces:**
- Consumes: `isMethodNotFoundError` from Task 2.
- Produces: handle-scoped generic config, mode, and model operations.

- [ ] **Step 1: Write failing controller tests**

Start with:

```ts
await expect(controller.setConfigOption(handle, 'thought_level', 'high')).resolves.toEqual(nextOptions);
expect(handle.connection.setSessionConfigOption).toHaveBeenCalledWith({
  sessionId: handle.providerSessionId,
  configId: 'thought_level',
  value: 'high',
});
expect(handle.configOptions).toEqual(nextOptions);
```

Add mode cache replacement, Claude unstable-model success, Claude `-32601` fallback to generic `model`, non-method-not-found propagation, Codex generic model behavior, config schema rejection, and warning logs.

- [ ] **Step 2: Run the direct test and verify RED**

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-config-controller.test.ts
```

Expected: FAIL because the controller is missing.

- [ ] **Step 3: Implement the handle-scoped controller**

Use:

```ts
export class AcpRuntimeConfigController {
  async setConfigOption(handle: AcpProcessHandle, configId: string, value: string): Promise<SessionConfigOption[]>;
  async setSessionMode(handle: AcpProcessHandle, modeId: string): Promise<SessionConfigOption[]>;
  async setSessionModel(handle: AcpProcessHandle, modelId: string): Promise<SessionConfigOption[]>;
}
```

Move the existing algorithms unchanged. Derive provider session ID from the handle and update only `handle.configOptions`.

- [ ] **Step 4: Delegate manager methods and preserve missing-session errors**

```ts
private requireInstalledHandle(sessionId: string): AcpProcessHandle {
  const handle = this.sessions.get(sessionId);
  if (!handle) throw new Error(`No ACP session found for sessionId: ${sessionId}`);
  return handle;
}

setConfigOption(sessionId: string, configId: string, value: string) {
  return this.configController.setConfigOption(this.requireInstalledHandle(sessionId), configId, value);
}
```

Apply the same pattern to mode and model.

- [ ] **Step 5: Run focused tests and commit**

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-config-controller.test.ts src/backend/services/session/service/acp/acp-runtime-manager.config.test.ts
pnpm typecheck
git add src/backend/services/session/service/acp
git commit -m "Extract ACP runtime configuration"
```

---

### Task 4: Extract prompt execution and timeout escalation

**PR stage:** 3

**Files:**
- Create: `acp-prompt-controller.ts`, `acp-prompt-controller.test.ts`.
- Modify: `acp-runtime-manager.ts`.
- Test: `acp-runtime-manager.prompt.test.ts`, `session.prompt.service.test.ts`.

**Interfaces:**
- Consumes: `PromptTimeoutError` from Task 2.
- Produces: handle-scoped prompt/cancel operations using current-handle and stop ports.

- [ ] **Step 1: Write failing prompt-controller tests**

Use:

```ts
const runtimePort: AcpPromptRuntimePort = {
  isCurrentHandle: vi.fn(() => true),
  stopClient: vi.fn().mockResolvedValue(undefined),
};
```

Cover prompt success/rejection, cancellation with no handle/not in flight/in flight, timeout cancellation success, cancellation failure, cancellation hang followed by stop, and stale-handle protection.

- [ ] **Step 2: Run the direct test and verify RED**

```bash
pnpm test src/backend/services/session/service/acp/acp-prompt-controller.test.ts
```

Expected: FAIL because the controller is missing.

- [ ] **Step 3: Implement prompt interfaces and logic**

```ts
export type AcpPromptRuntimePort = {
  isCurrentHandle(sessionId: string, handle: AcpProcessHandle): boolean;
  stopClient(sessionId: string): Promise<void>;
};

export class AcpPromptController {
  constructor(private readonly runtime: AcpPromptRuntimePort) {}
  sendPrompt(sessionId: string, handle: AcpProcessHandle, prompt: ContentBlock[], timeoutMs?: number): Promise<{ stopReason: string }>;
  cancelPrompt(sessionId: string, handle: AcpProcessHandle | undefined): Promise<boolean>;
}
```

Move the existing timer, five-second cancel bound, stale-handle checks, best-effort stop, logs, and `isPromptInFlight` transitions unchanged.

- [ ] **Step 4: Delegate manager prompt methods**

Construct transitional manager-backed ports:

```ts
this.promptController = new AcpPromptController({
  isCurrentHandle: (sessionId, handle) => this.sessions.get(sessionId) === handle,
  stopClient: (sessionId) => this.stopClient(sessionId),
});
```

Delegate `sendPrompt` after the existing missing-session error, delegate public `cancelPrompt`, and call `cancelPrompt(sessionId, handle)` from `stopClientOnce`.

- [ ] **Step 5: Complete Stage 3 verification and commit**

```bash
pnpm test src/backend/services/session/service/acp/acp-prompt-controller.test.ts src/backend/services/session/service/acp/acp-runtime-manager.prompt.test.ts src/backend/services/session/service/lifecycle/session.prompt.service.test.ts
pnpm typecheck
```

Run the full repository checks, then:

```bash
git add src/backend/services/session/service/acp
git commit -m "Extract ACP prompt control"
```

---

### Task 5: Extract the stateless ACP client factory

**PR stage:** 4

**Files:**
- Create: `acp-runtime-contracts.ts`, `acp-client-factory.ts`, `acp-client-factory.test.ts`.
- Modify: `acp-runtime-error-handler.ts`, `acp-runtime-manager.ts`.
- Test: manager creation and session negotiation integration suites.

**Interfaces:**
- Consumes: Task 2 errors and existing spawn, stream, handler, and config helpers.
- Produces: internal metadata/signal contracts and an uninstalled handle.

- [ ] **Step 1: Define contracts and write failing factory tests**

Create:

```ts
export type AcpRuntimeMetadata = {
  incarnationId: string;
  purpose: AcpRuntimePurpose;
  installed: boolean;
};

export type AcpRuntimeContext = { workspaceId: string; workingDir: string };

export type AcpStartupSignal = {
  promise: Promise<never>;
  dispose(): void;
};

export type AcpRuntimeCreatedCallback = (
  sessionId: string,
  client: AcpProcessHandle,
  context: AcpRuntimeContext
) => void;
```

Replace the manager-local callback type with `export type { AcpRuntimeCreatedCallback } from './acp-runtime-contracts';` so the existing deep import remains source-compatible. Update `acp-runtime-error-handler.ts` to use `Pick<AcpRuntimeMetadata, 'incarnationId' | 'purpose'>` instead of its local context type.

Write factory tests for empty working directory, Claude/Codex/override spawn commands, environment and stdio, initialization, new session, stored-session load, active load fallback, browse load failure, invalid config options, spawn error, startup timeout, stop/shutdown cancellation, stderr logging, permission policy, and failed-start SIGTERM/SIGKILL cleanup.

- [ ] **Step 2: Run the factory test and verify RED**

```bash
pnpm test src/backend/services/session/service/acp/acp-client-factory.test.ts
```

Expected: FAIL because the factory does not exist.

- [ ] **Step 3: Implement factory configuration and creation**

Use:

```ts
export type CreateAcpClientParams = {
  sessionId: string;
  options: AcpClientOptions;
  handlers: AcpRuntimeEventHandlers;
  metadata: AcpRuntimeMetadata;
  shutdownSignal: AcpStartupSignal;
  stopSignal: AcpStartupSignal;
  shouldDispatchRuntimeError(child: ChildProcess): boolean;
};

export class AcpClientFactory {
  constructor(options?: { acpStartupTimeoutMs?: number });
  setAcpStartupTimeoutMs(timeoutMs: number): void;
  configureEnvironment(options: {
    preferSourceEntrypoint: boolean;
    childProcessEnvProvider: () => NodeJS.ProcessEnv;
  }): void;
  createClient(params: CreateAcpClientParams): Promise<AcpProcessHandle>;
}
```

Move `resolveAutoApprovePolicy`, spawn/stream construction, SDK setup, initialization, create/resume negotiation, load-failure logging, and failed-start cleanup. Do not add maps or retain handles.

- [ ] **Step 4: Keep installation in the manager temporarily**

The manager creates/disposes cancellation signals, calls the factory, rechecks shutdown/stop, then performs the current synchronous installation order:

```ts
const handle = await this.clientFactory.createClient({
  sessionId,
  options,
  handlers,
  metadata,
  shutdownSignal,
  stopSignal,
  shouldDispatchRuntimeError: (child) =>
    !metadata.installed || this.sessions.get(sessionId)?.child === child,
});
this.sessions.set(sessionId, handle);
metadata.installed = true;
this.recordClientPurpose(sessionId, options);
this.wireChildExitHandler(sessionId, handle.child, handlers, metadata);
await this.notifyClientCreated(sessionId, handle, context, handlers);
return handle;
```

- [ ] **Step 5: Run focused and integration tests**

```bash
pnpm test src/backend/services/session/service/acp/acp-client-factory.test.ts src/backend/services/session/service/acp/acp-runtime-manager.creation.test.ts
pnpm test:integration
pnpm typecheck
```

- [ ] **Step 6: Verify and commit Stage 4**

Run the full repository checks, then:

```bash
git add src/backend/services/session/service/acp
git commit -m "Extract ACP client factory"
```

---

### Task 6: Build the state-owning runtime supervisor behind tests

**PR stage:** 5

**Files:**
- Create: `acp-runtime-supervisor.ts`, `acp-runtime-supervisor.creation.test.ts`, `acp-runtime-supervisor.termination.test.ts`.
- Modify: `acp-runtime-contracts.ts`.

**Interfaces:**
- Consumes: `AcpClientFactory`, prompt cancellation, exit/error helpers, and `AcpRuntimeQuiescence`.
- Produces: every stateful creation, registry, status, stop, exit, quiescence, and shutdown operation.

- [ ] **Step 1: Write creation and exit tests**

Start with a mocked factory:

```ts
const factory = { createClient: vi.fn() };
const supervisor = new AcpRuntimeSupervisor({
  clientFactory: factory,
  cancelPrompt: vi.fn().mockResolvedValue(false),
});

const first = supervisor.getOrCreateClient('session-1', options, handlers, context);
const second = supervisor.getOrCreateClient('session-1', options, handlers, context);
expect(factory.createClient).toHaveBeenCalledTimes(1);
await expect(second).resolves.toBe(await first);
```

Cover active/browse promotion, pending creation, different-session concurrency, lock release, exit fencing, reentrant same-session rejection, managed/stale exits, runtime-error predicates, callback ordering, and status/process queries.

- [ ] **Step 2: Write termination and shutdown tests**

Exercise the creation barrier with deferred factory work:

```ts
const creation = supervisor.runClientCreationOperation('session-1', 'active', () =>
  supervisor.getOrCreateClient('session-1', options, handlers, context)
);
const firstStop = supervisor.stopAndQuiesce('session-1');
const secondStop = supervisor.stopAndQuiesce('session-1');
expect(secondStop).toBe(firstStop);
factoryCreation.resolve(handle);
await Promise.allSettled([creation, firstStop]);
expect(handle.child.kill).toHaveBeenCalledWith('SIGTERM');
expect(supervisor.getClient('session-1')).toBeUndefined();
```

Also cover duplicate `stopClient`, failed first stop with/without barriers, cancellation before SIGTERM, SIGKILL escalation, shutdown admission, active+browse+pending inventory, pending timeout, quiescence wait, final sweep, and registry cleanup.

- [ ] **Step 3: Run both tests and verify RED**

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-supervisor.creation.test.ts src/backend/services/session/service/acp/acp-runtime-supervisor.termination.test.ts
```

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 4: Implement supervisor dependencies and state**

Use:

```ts
export type AcpRuntimeSupervisorDependencies = {
  clientFactory: Pick<AcpClientFactory, 'createClient'>;
  cancelPrompt(sessionId: string, handle: AcpProcessHandle): Promise<boolean>;
};

export class AcpRuntimeSupervisor {
  private readonly sessions = new Map<string, AcpProcessHandle>();
  private readonly browseOnlySessions = new Set<string>();
  private readonly pendingCreation = new Map<string, Promise<AcpProcessHandle>>();
  private readonly stoppingInProgress = new Set<string>();
  private readonly stopOperations = new Map<string, Promise<void>>();
  private readonly managedStopChildren = new WeakSet<ChildProcess>();
  private readonly runtimeMetadata = new WeakMap<ChildProcess, AcpRuntimeMetadata>();
  private readonly exitHandling = new Map<string, Promise<void>>();
  private readonly creationLocks = new Map<string, ReturnType<typeof pLimit>>();
  private readonly lockRefCounts = new Map<string, number>();
  private readonly shutdownWaiters = new Set<() => void>();
  private readonly sessionStopWaiters = new Map<string, Set<() => void>>();
  private readonly quiescence: AcpRuntimeQuiescence;
  private isShuttingDown = false;
}
```

The supervisor creates metadata with `randomUUID`, owns startup signals, calls the factory, installs/removes handles, wires exit handling, and invokes creation callbacks. `getInstalledHandle` intentionally exposes the raw installed-map lookup to the facade so prompt/config methods preserve their current behavior; public `getClient` continues to hide browse-only or non-running handles. Do not mirror these collections in the manager after cutover.

- [ ] **Step 5: Implement the complete method surface**

```ts
setOnClientCreated(callback: AcpRuntimeCreatedCallback): void;
isStopInProgress(sessionId: string): boolean;
getClient(sessionId: string): AcpProcessHandle | undefined;
getBrowseClient(sessionId: string): AcpProcessHandle | undefined;
getInstalledHandle(sessionId: string): AcpProcessHandle | undefined;
isBrowseOnlySession(sessionId: string): boolean;
hasClientCreationOperation(sessionId: string): boolean;
getPendingClient(sessionId: string): Promise<AcpProcessHandle> | undefined;
runClientCreationOperation<T>(sessionId: string, purpose: AcpRuntimePurpose, operation: (registration: AcpClientCreationOperation) => Promise<T>): Promise<T>;
stopAndQuiesce(sessionId: string): Promise<void>;
getOrCreateClient(sessionId: string, options: AcpClientOptions, handlers: AcpRuntimeEventHandlers, context: AcpRuntimeContext): Promise<AcpProcessHandle>;
isCurrentHandle(sessionId: string, handle: AcpProcessHandle): boolean;
beginShutdown(): string[];
stopClient(sessionId: string): Promise<void>;
stopAllClients(timeoutMs?: number): Promise<void>;
getAllClients(): IterableIterator<[string, AcpProcessHandle]>;
isSessionRunning(sessionId: string): boolean;
isSessionWorking(sessionId: string): boolean;
isAnySessionWorking(sessionIds: string[]): boolean;
getAllActiveProcesses(): AcpActiveProcessSnapshot[];
```

Define this exact type in `acp-runtime-contracts.ts`:

```ts
export type AcpActiveProcessSnapshot = {
  sessionId: string;
  pid: number | undefined;
  status: string;
  isRunning: boolean;
  isPromptInFlight: boolean;
  provider: string;
};
```

- [ ] **Step 6: Run tests and size checks**

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-supervisor.creation.test.ts src/backend/services/session/service/acp/acp-runtime-supervisor.termination.test.ts
pnpm typecheck
wc -l src/backend/services/session/service/acp/acp-runtime-supervisor.ts src/backend/services/session/service/acp/acp-runtime-supervisor.creation.test.ts src/backend/services/session/service/acp/acp-runtime-supervisor.termination.test.ts
```

Expected: tests pass; every new file is below 1,000 lines.

- [ ] **Step 7: Commit the tested internal supervisor**

```bash
git add src/backend/services/session/service/acp/acp-runtime-contracts.ts src/backend/services/session/service/acp/acp-runtime-supervisor.ts src/backend/services/session/service/acp/acp-runtime-supervisor.creation.test.ts src/backend/services/session/service/acp/acp-runtime-supervisor.termination.test.ts
git commit -m "Add ACP runtime supervisor"
```

---

### Task 7: Cut manager state over to the supervisor

**PR stage:** 5

**Files:**
- Modify: `acp-runtime-manager.ts`, `acp-runtime-manager.facade.test.ts`.
- Test: every focused manager, collaborator, and supervisor suite.

**Interfaces:**
- Consumes: complete supervisor surface from Task 6.
- Produces: a manager graph with no cross-session registry in the facade.

- [ ] **Step 1: Add a failing facade ownership assertion**

```ts
const source = readFileSync(new URL('./acp-runtime-manager.ts', import.meta.url), 'utf8');
for (const forbidden of [
  'new Map<string, AcpProcessHandle>()',
  'new Map<string, Promise<AcpProcessHandle>>()',
  'new WeakMap<ChildProcess, AcpRuntimeMetadata>()',
  'new Set<string>()',
]) {
  expect(source).not.toContain(forbidden);
}
expect(source.match(/new AcpRuntimeSupervisor\(/g)).toHaveLength(1);
```

- [ ] **Step 2: Run the facade test and verify RED**

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-manager.facade.test.ts
```

Expected: FAIL because the manager still owns collections.

- [ ] **Step 3: Construct the collaborator graph**

Use this order to resolve the prompt/stop cycle through narrow callbacks:

```ts
export class AcpRuntimeManager {
  private readonly clientFactory: AcpClientFactory;
  private readonly promptController: AcpPromptController;
  private readonly configController = new AcpRuntimeConfigController();
  private readonly subagentBrowser = new AcpSubagentBrowser();
  private readonly supervisor: AcpRuntimeSupervisor;

  constructor(options?: { acpStartupTimeoutMs?: number }) {
    this.clientFactory = new AcpClientFactory(options);
    let supervisor!: AcpRuntimeSupervisor;
    this.promptController = new AcpPromptController({
      isCurrentHandle: (sessionId, handle) => supervisor.isCurrentHandle(sessionId, handle),
      stopClient: (sessionId) => supervisor.stopClient(sessionId),
    });
    supervisor = new AcpRuntimeSupervisor({
      clientFactory: this.clientFactory,
      cancelPrompt: (sessionId, handle) => this.promptController.cancelPrompt(sessionId, handle),
    });
    this.supervisor = supervisor;
  }
}
```

- [ ] **Step 4: Delegate every method by ownership**

| Manager methods | Delegate |
| --- | --- |
| startup timeout/environment | `clientFactory` |
| callbacks, handle/purpose/pending queries | `supervisor` |
| creation barrier, creation, stop, shutdown | `supervisor` |
| process/status queries | `supervisor` |
| browse capability/list/transcript | `subagentBrowser` with supervisor browse handle |
| prompt/cancel | `promptController` with supervisor raw installed handle |
| config/mode/model | `configController` with supervisor raw installed handle |

Representative methods:

```ts
getOrCreateClient(sessionId: string, options: AcpClientOptions, handlers: AcpRuntimeEventHandlers, context: AcpRuntimeContext) {
  return this.supervisor.getOrCreateClient(sessionId, options, handlers, context);
}

sendPrompt(sessionId: string, prompt: ContentBlock[], timeoutMs?: number) {
  return this.promptController.sendPrompt(sessionId, this.requireInstalledHandle(sessionId), prompt, timeoutMs);
}

stopAllClients(timeoutMs = 5000) {
  return this.supervisor.stopAllClients(timeoutMs);
}
```

- [ ] **Step 5: Run the complete ACP runtime matrix**

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-manager.creation.test.ts src/backend/services/session/service/acp/acp-runtime-manager.browsing.test.ts src/backend/services/session/service/acp/acp-runtime-manager.termination.test.ts src/backend/services/session/service/acp/acp-runtime-manager.prompt.test.ts src/backend/services/session/service/acp/acp-runtime-manager.config.test.ts src/backend/services/session/service/acp/acp-runtime-manager.facade.test.ts src/backend/services/session/service/acp/acp-runtime-supervisor.creation.test.ts src/backend/services/session/service/acp/acp-runtime-supervisor.termination.test.ts src/backend/services/session/service/acp/acp-client-factory.test.ts src/backend/services/session/service/acp/acp-prompt-controller.test.ts src/backend/services/session/service/acp/acp-runtime-config-controller.test.ts src/backend/services/session/service/acp/acp-subagent-browser.test.ts
pnpm test:integration
pnpm typecheck
```

- [ ] **Step 6: Verify and commit Stage 5**

Run the full repository checks, then:

```bash
git add src/backend/services/session/service/acp
git commit -m "Move ACP runtime state to supervisor"
```

---

### Task 8: Finish the facade, audit ownership, document, and lower the baseline

**PR stage:** 6

**Files:**
- Modify: `acp-runtime-manager.ts`, `acp-runtime-manager.facade.test.ts`, `acp/index.ts`.
- Modify: `docs/architecture/agent-runtime.md`, `scripts/file-length-baseline.json`.

**Interfaces:**
- Consumes: all prior collaborators.
- Produces: final compatibility facade below roughly 600 lines and unchanged public exports.

- [ ] **Step 1: Add final public-surface and barrel assertions**

```ts
type ExpectedRuntimeSurface = Pick<
  AcpRuntimeManager,
  | 'setAcpStartupTimeoutMs'
  | 'configureEnvironment'
  | 'setOnClientCreated'
  | 'isStopInProgress'
  | 'getClient'
  | 'getBrowseClient'
  | 'isBrowseOnlySession'
  | 'hasClientCreationOperation'
  | 'getPendingClient'
  | 'getOrCreateClient'
  | 'runClientCreationOperation'
  | 'stopAndQuiesce'
  | 'beginShutdown'
  | 'stopClient'
  | 'stopAllClients'
  | 'sendPrompt'
  | 'cancelPrompt'
  | 'setConfigOption'
  | 'setSessionMode'
  | 'setSessionModel'
  | 'getSubagentBrowseCapability'
  | 'listSubagents'
  | 'readSubagentTranscript'
  | 'getAllClients'
  | 'isSessionRunning'
  | 'isSessionWorking'
  | 'isAnySessionWorking'
  | 'getAllActiveProcesses'
>;

const acceptsExpectedRuntimeSurface = (_runtime: ExpectedRuntimeSurface): void => undefined;
acceptsExpectedRuntimeSurface(new AcpRuntimeManager());
```

Add a source assertion that `acp/index.ts` does not export any internal collaborator.

- [ ] **Step 2: Run facade tests**

```bash
pnpm test src/backend/services/session/service/acp/acp-runtime-manager.facade.test.ts
```

Expected: PASS if Stage 5 completed the facade; otherwise fail only on transitional state/exports removed next.

- [ ] **Step 3: Remove transitional code and run ownership audits**

```bash
rg -n "new (Map|Set|WeakMap)|creationLocks|pendingCreation|runtimeMetadata|stopOperations|shutdownWaiters" src/backend/services/session/service/acp/acp-runtime-manager.ts
rg -n "as unknown as.*AcpRuntimeManager" src/backend/services/session/service/acp --glob '*.test.ts'
rg -n "AcpRuntimeSupervisor|AcpClientFactory|AcpPromptController|AcpRuntimeConfigController|AcpSubagentBrowser" src/backend/services/session/service/acp/index.ts src/backend/services/session/service/index.ts
```

Expected: no matches. The facade contains collaborator fields and delegation only.

- [ ] **Step 4: Update the architecture guide**

Use this ownership statement:

```markdown
`SessionLifecycleGate` owns domain startup/stop eligibility.
`AcpRuntimeSupervisor` is the sole mutable ACP runtime authority: it owns
subprocess handles, pending creation, incarnation filtering, exits, stops, and
quiescence. `AcpRuntimeManager` is the stable compatibility facade over the
supervisor and stateless ACP collaborators. Lifecycle coordinators continue to
own durable reconciliation and never manipulate runtime registries directly.
```

- [ ] **Step 5: Remove the manager baseline entry**

```bash
wc -l src/backend/services/session/service/acp/acp-runtime-manager.ts
pnpm check:file-length:update
pnpm check:file-length
git diff -- scripts/file-length-baseline.json
```

Expected: manager below roughly 600 lines; its 1,449-line entry removed; no count grows.

- [ ] **Step 6: Run affected integration and lifecycle tests**

```bash
pnpm test src/backend/services/session/service/acp src/backend/services/session/service/lifecycle/session-startup.coordinator.test.ts src/backend/services/session/service/lifecycle/session-termination.coordinator.test.ts src/backend/services/session/service/lifecycle/session.prompt.service.test.ts src/backend/trpc/session.router.test.ts src/backend/trpc/admin.router.test.ts src/backend/routers/websocket/voice-soft-stop.handler.test.ts
pnpm test:integration
```

- [ ] **Step 7: Run final repository verification**

Run in order:

```bash
pnpm check:fix
pnpm typecheck
pnpm test
pnpm check
git diff --check
```

If local Codex CLI differs from the pin, report the normal schema skip exactly; CI remains strict.

- [ ] **Step 8: Commit Stage 6**

```bash
git add src/backend/services/session/service/acp docs/architecture/agent-runtime.md scripts/file-length-baseline.json
git commit -m "Finish ACP runtime manager modularization"
```

- [ ] **Step 9: Perform final acceptance audit**

```bash
git status --short
wc -l src/backend/services/session/service/acp/acp-runtime-manager.ts src/backend/services/session/service/acp/acp-runtime-supervisor.ts src/backend/services/session/service/acp/acp-client-factory.ts src/backend/services/session/service/acp/acp-prompt-controller.ts src/backend/services/session/service/acp/acp-runtime-config-controller.ts src/backend/services/session/service/acp/acp-subagent-browser.ts
rg -n "acp-runtime-manager(.test)?\.ts" scripts/file-length-baseline.json
```

Expected: clean worktree; every focused source below 1,000 lines; facade below roughly 600; neither original manager entry remains in the baseline.
