# Session Service Facade Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SessionService`'s forwarding API with direct use of focused session services while retaining `SessionService` for serialized ACP prompt execution.

**Architecture:** Add a session-capsule composition module that constructs and exports the shared focused service instances. Inject prompt sending into `SessionLifecycleService`, inject lifecycle-state readers into the prompt-only `SessionService`, and migrate every caller to the service that owns its operation.

**Tech Stack:** TypeScript, Express/tRPC, ACP SDK, Vitest, Biome, pnpm

## Global Constraints

- Keep `sessionService` for prompt coordination only.
- Export the focused session service instances through `@/backend/services/session`.
- Add no deprecated forwarding methods or compatibility aliases.
- Preserve current prompt serialization, lifecycle, configuration, permission, runtime-state, and workspace-activity behavior.
- External consumers import only from the session barrel.
- Keep tests beside the session modules or existing backend consumers they cover.

---

### Task 1: Make prompt sending a lifecycle dependency

**Files:**
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts`

**Interfaces:**
- Consumes: `SendSessionMessage = (sessionId: string, content: string) => Promise<void>`
- Produces: `SessionLifecycleServiceDependencies.sendSessionMessage`
- Produces: `startSession(sessionId: string, options?: StartSessionOptions): Promise<void>`
- Produces: `restartSession(sessionId: string, options?: StartSessionOptions): Promise<void>`

- [ ] **Step 1: Change the lifecycle tests to express constructor-injected prompt sending**

Update the lifecycle test builders to pass `sendSessionMessage` in the constructor:

```ts
const sendSessionMessage = vi.fn(async () => undefined);
const service = new SessionLifecycleService({
  repository: repository as never,
  promptBuilder: promptBuilder as never,
  runtimeManager: runtimeManager as never,
  sessionDomainService: sessionDomainService as never,
  sessionPermissionService: sessionPermissionService as never,
  sessionConfigService: sessionConfigService as never,
  acpEventProcessor: acpEventProcessor as never,
  promptTurnCompletionService: promptTurnCompletionService as never,
  retryService: retryService as never,
  sendSessionMessage,
});
```

Call `service.startSession('session-1', options)` and `service.restartSession('session-1', options)` without passing the sender as a method argument. Retain assertions that explicit prompts are sent once and queued notifications suppress the default prompt.

- [ ] **Step 2: Run the focused lifecycle tests and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
```

Expected: TypeScript/Vitest fails because `sendSessionMessage` is not a constructor dependency and the existing methods still require it as an argument.

- [ ] **Step 3: Inject and use the prompt sender**

Add the dependency and store it:

```ts
export type SessionLifecycleServiceDependencies = {
  repository: SessionRepository;
  promptBuilder: SessionPromptBuilder;
  runtimeManager: AcpRuntimeManager;
  sessionDomainService: SessionDomainService;
  sessionPermissionService: SessionPermissionService;
  sessionConfigService: SessionConfigService;
  acpEventProcessor: AcpEventProcessor;
  promptTurnCompletionService: SessionPromptTurnCompletionService;
  retryService: SessionRetryService;
  sendSessionMessage: SendSessionMessage;
  onBeforeStopSession?: (sessionId: string) => void;
  onSessionExit?: (sessionId: string) => void;
};
```

Remove the sender parameter from `startSession` and `restartSession`, and use `this.sendSessionMessage` for initial and restart prompts.

- [ ] **Step 4: Run the focused lifecycle tests and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
```

Expected: all lifecycle tests pass.

- [ ] **Step 5: Commit the lifecycle API change**

```bash
git add src/backend/services/session/service/lifecycle/session.lifecycle.service.ts \
  src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts
git commit -m "Inject session lifecycle prompt sender"
```

---

### Task 2: Build the focused service graph and shrink SessionService

**Files:**
- Create: `src/backend/services/session/service/lifecycle/session-services.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.service.ts`
- Modify: `src/backend/services/session/service/lifecycle/session.service.test.ts`
- Delete: `src/backend/services/session/service/lifecycle/session.service.coverage.test.ts`

**Interfaces:**
- Produces: `sessionPermissionService: SessionPermissionService`
- Produces: `sessionConfigService: SessionConfigService`
- Produces: `acpEventProcessor: AcpEventProcessor`
- Produces: `sessionPromptTurnCompletionService: SessionPromptTurnCompletionService`
- Produces: `sessionRetryService: SessionRetryService`
- Produces: `sessionLifecycleService: SessionLifecycleService`
- Produces: `sessionService: SessionPromptService`, narrowed to the public prompt API
- Keeps: a private `SessionService` coordinator whose queue cleanup is used only by lifecycle hooks

- [ ] **Step 1: Point behavioral tests at the intended focused instances**

In `session.service.test.ts`, import the service graph:

```ts
import {
  acpEventProcessor,
  sessionConfigService,
  sessionLifecycleService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionService,
} from './session-services';
```

Replace lifecycle calls such as `sessionService.startSession`, `stopSession`, `getSessionClient`, `getRuntimeSnapshot`, `getStopGeneration`, and `stopAllClients` with `sessionLifecycleService`. Replace config, permission, and completion-handler calls with their owning instances. Access ACP processor state directly instead of casting through a private `SessionService` field.

Keep prompt assertions on `sessionService.sendSessionMessage` and `sessionService.sendAcpMessage`.

- [ ] **Step 2: Run the existing SessionService behavioral suite and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/lifecycle/session.service.test.ts
```

Expected: module resolution fails for `./session-services`.

- [ ] **Step 3: Reduce SessionService to prompt coordination**

Change its dependencies to explicit prompt collaborators:

```ts
export type SessionServiceDependencies = {
  runtimeManager: AcpRuntimeManager;
  sessionDomainService: SessionDomainService;
  acpEventProcessor: AcpEventProcessor;
  promptTurnCompletionService: SessionPromptTurnCompletionService;
  getStopGeneration: (sessionId: string) => number;
  isSessionStopping: (sessionId: string) => boolean;
};
```

Retain:

- workspace bridge configuration
- `sendSessionMessage`
- content-block conversion
- `sendAcpMessage`
- per-session limiter creation, cleanup, and rejection
- ACP prompt execution and prompt-turn finalization

Remove all lifecycle, configuration, permission, runtime query, history, repository, and shutdown forwarding methods. Replace internal calls to the removed lifecycle methods with `getStopGeneration` and `isSessionStopping` dependencies.

- [ ] **Step 4: Create the composition module**

Construct the graph once in `session-services.ts`. The key wiring is:

```ts
export const sessionPermissionService = new SessionPermissionService({
  sessionDomainService,
});
export const sessionConfigService = new SessionConfigService({
  repository: sessionRepository,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
});
export const sessionPromptTurnCompletionService =
  new SessionPromptTurnCompletionService();
export const sessionRetryService = new SessionRetryService();
export const acpEventProcessor = new AcpEventProcessor({
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionPermissionService,
  sessionConfigService,
  onToolCallTimeout: cancelTimedOutToolPrompt,
});
export type SessionPromptService = Pick<
  SessionService,
  'configure' | 'sendAcpMessage' | 'sendSessionMessage'
>;
const sessionPromptCoordinator = new SessionService({
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  getStopGeneration: (sessionId) =>
    sessionLifecycleService.getStopGeneration(sessionId),
  isSessionStopping: (sessionId) =>
    sessionLifecycleService.isSessionStopping(sessionId),
});
export const sessionService: SessionPromptService = sessionPromptCoordinator;
export const sessionLifecycleService = new SessionLifecycleService({
  repository: sessionRepository,
  promptBuilder: sessionPromptBuilder,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionPermissionService,
  sessionConfigService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  retryService: sessionRetryService,
  sendSessionMessage: (sessionId, content) =>
    sessionService.sendSessionMessage(sessionId, content),
  onBeforeStopSession: (sessionId) =>
    sessionPromptCoordinator.clearQueuedAcpPrompts(sessionId),
  onSessionExit: (sessionId) =>
    sessionPromptCoordinator.clearQueuedAcpPrompts(sessionId),
});
```

Move the tool-timeout cancellation callback from the old constructor into this composition module, preserving both runtime guards and logging.

- [ ] **Step 5: Remove delegation-only coverage**

Delete `session.service.coverage.test.ts`. Its wrapper assertions are intentionally obsolete; retain its content conversion and limiter behaviors only if they are not already covered in `session.service.test.ts`.

- [ ] **Step 6: Run the session graph tests and verify GREEN**

Run:

```bash
pnpm vitest run \
  src/backend/services/session/service/lifecycle/session.service.test.ts \
  src/backend/services/session/service/lifecycle/session.lifecycle.service.test.ts \
  src/backend/services/session/service/lifecycle/session.config.service.test.ts \
  src/backend/services/session/service/lifecycle/session.permission.service.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit the focused service graph**

```bash
git add src/backend/services/session/service/lifecycle/session-services.ts \
  src/backend/services/session/service/lifecycle/session.service.ts \
  src/backend/services/session/service/lifecycle/session.service.test.ts \
  src/backend/services/session/service/lifecycle/session.service.coverage.test.ts
git commit -m "Split focused session services from facade"
```

---

### Task 3: Publish the focused API and migrate session-internal callers

**Files:**
- Modify: `src/backend/services/session/service/index.ts`
- Modify: `src/backend/services/session/service/interceptor.bridge.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers.service.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/types.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/registry.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/load-session.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/permission-response.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/set-config-option.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/set-model.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/set-thinking-budget.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/start.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/stop.handler.ts`
- Modify: `src/backend/services/session/service/chat/chat-message-handlers/handlers/user-input.handler.ts`
- Modify: co-located tests under `src/backend/services/session/service/chat/`

**Interfaces:**
- Produces: barrel exports for the eight focused sub-services and prompt-only `sessionService`
- Produces: handler dependencies split by `sessionLifecycleService`, `sessionConfigService`, `sessionPermissionService`, `acpRuntimeManager`, and `sessionService`
- Produces: transcript conversion local to `sessionInterceptorBridge`

- [ ] **Step 1: Update handler tests to inject focused dependencies**

Replace the broad `ChatMessageHandlerSessionService` fake with capability-specific interfaces. For example:

```ts
const deps = {
  sessionConfigService: {
    setSessionModel: vi.fn(async () => undefined),
    setSessionReasoningEffort: vi.fn(async () => undefined),
    getChatBarCapabilities: vi.fn(async () => capabilities),
  },
};
```

For user input, inject `acpRuntimeManager.isSessionRunning` and `sessionService.sendSessionMessage`. For permission responses, inject `sessionPermissionService.respondToPermission`. For start/stop handlers, inject `sessionLifecycleService`.

- [ ] **Step 2: Run chat handler tests and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/session/service/chat
```

Expected: tests fail because handler factories and registry still accept the broad session facade.

- [ ] **Step 3: Export the focused instances**

Replace the old lifecycle export in the session service barrel:

```ts
export {
  acpEventProcessor,
  sessionConfigService,
  sessionLifecycleService,
  sessionPermissionService,
  sessionPromptTurnCompletionService,
  sessionRetryService,
  sessionService,
} from './lifecycle/session-services';
export { SessionService } from './lifecycle/session.service';
export { SessionLifecycleService } from './lifecycle/session.lifecycle.service';
export { SessionConfigService } from './lifecycle/session.config.service';
export { SessionPermissionService } from './lifecycle/session.permission.service';
```

Continue exporting `sessionRepository` and `sessionPromptBuilder` from their existing modules.

- [ ] **Step 4: Migrate chat and interceptor callers**

Use focused dependencies for every handler operation. In `interceptor.bridge.ts`, map transcript entries to `HistoryMessage[]` locally, read them from `sessionDomainService`, query running state from `acpRuntimeManager`, and retain prompt sending through `sessionService`.

Do not add an aggregate replacement service interface. Each handler factory accepts only the capabilities it invokes.

- [ ] **Step 5: Run chat and interceptor tests and verify GREEN**

Run:

```bash
pnpm vitest run \
  src/backend/services/session/service/chat \
  src/backend/interceptors
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the public API and internal migration**

```bash
git add src/backend/services/session/service/index.ts \
  src/backend/services/session/service/interceptor.bridge.ts \
  src/backend/services/session/service/chat
git commit -m "Use focused services in session handlers"
```

---

### Task 4: Migrate application, orchestration, router, and server callers

**Files:**
- Modify: `src/backend/app-context.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`
- Modify: `src/backend/orchestration/event-collector.orchestrator.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-init.orchestrator.ts`
- Modify: `src/backend/routers/websocket/chat.handler.ts`
- Modify: `src/backend/server.ts`
- Modify: `src/backend/trpc/admin.trpc.ts`
- Modify: `src/backend/trpc/session.trpc.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`
- Modify: `src/backend/trpc/workspace/children.trpc.ts`
- Modify: corresponding co-located tests and dependency fixtures

**Interfaces:**
- Produces: `ApplicationServices.sessionLifecycleService`
- Produces: `ApplicationServices.sessionPromptTurnCompletionService`
- Produces: `ApplicationServices.sessionRepository`
- Retains: `ApplicationServices.sessionService` for prompt sending only

- [ ] **Step 1: Update representative dependency fixtures first**

Change application, orchestration, router, and server test fixtures to provide focused services. Representative fixture shape:

```ts
{
  acpRuntimeManager: {
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    isAnySessionWorking: vi.fn(),
  },
  sessionLifecycleService: {
    startSession: vi.fn(),
    stopSession: vi.fn(),
    restartSession: vi.fn(),
    stopWorkspaceSessions: vi.fn(),
    getRuntimeSnapshot: vi.fn(),
  },
  sessionPromptTurnCompletionService: {
    setHandler: vi.fn(),
  },
  sessionRepository: {
    recoverStaleRunningSessions: vi.fn(),
  },
  sessionService: {
    sendSessionMessage: vi.fn(),
    sendAcpMessage: vi.fn(),
  },
}
```

- [ ] **Step 2: Run representative suites and verify RED**

Run:

```bash
pnpm vitest run \
  src/backend/app-context.test.ts \
  src/backend/orchestration/domain-bridges.orchestrator.test.ts \
  src/backend/trpc/session.router.test.ts \
  src/backend/routers/websocket/chat.handler.test.ts \
  src/backend/server.upgrade.test.ts
```

Expected: dependency shape and call assertions fail because production callers still use `sessionService` for non-prompt operations.

- [ ] **Step 3: Migrate the application context and bridge wiring**

Add the focused instances to default application services. Build snapshot reconciliation with `sessionLifecycleService.getRuntimeSnapshot`.

In domain bridge wiring:

- use `sessionLifecycleService` for start/stop/restart and runtime snapshots
- use `acpRuntimeManager` for running/working predicates
- configure lifecycle and prompt services separately
- set prompt completion through `sessionPromptTurnCompletionService.setHandler`
- retain `sessionService` only for prompt sends

- [ ] **Step 4: Migrate remaining backend consumers**

Apply the ownership table consistently:

- WebSocket client creation and runtime snapshots → `sessionLifecycleService`
- runtime running/working predicates → `acpRuntimeManager`
- workspace cleanup and initialization → `sessionLifecycleService`
- tRPC start/stop/restart → `sessionLifecycleService`
- tRPC working predicates → `acpRuntimeManager`
- graceful shutdown → `sessionLifecycleService.stopAllClients`
- startup stale recovery → `sessionRepository.recoverStaleRunningSessions`

Keep the startup recovery log in `server.ts`:

```ts
const recoveredCount = await sessionRepository.recoverStaleRunningSessions();
if (recoveredCount > 0) {
  logger.info('Recovered stale agent session states on startup', {
    recoveredCount,
  });
}
```

- [ ] **Step 5: Prove no non-prompt facade calls remain**

Run:

```bash
rg -n "sessionService\\.(configure|setPromptTurnCompleteHandler|startSession|stopSession|restartSession|stopWorkspaceSessions|recoverStaleSessionStates|getOrCreateSessionClient|getSessionClient|getSessionConfigOptions|setSession|getRuntimeSnapshot|isSession|getStopGeneration|getSessionOptions|getChatBarCapabilities|stopAllClients|respondToAcpPermission|getSessionConversationHistory)" src/backend
```

Expected: no matches.

- [ ] **Step 6: Run backend consumer tests and typecheck**

Run:

```bash
pnpm vitest run \
  src/backend/orchestration \
  src/backend/routers/websocket \
  src/backend/trpc \
  src/backend/server.upgrade.test.ts
pnpm typecheck
```

Expected: all selected tests pass and TypeScript reports no errors.

- [ ] **Step 7: Commit the caller migration**

```bash
git add src/backend/app-context.ts \
  src/backend/orchestration \
  src/backend/routers/websocket \
  src/backend/server.ts \
  src/backend/server.upgrade.test.ts \
  src/backend/trpc
git commit -m "Migrate callers to focused session services"
```

---

### Task 5: Format, validate, and prepare the pull request

**Files:**
- Modify: any task-owned TypeScript file changed mechanically by Biome
- Review: `docs/superpowers/specs/2026-07-26-session-service-facade-cleanup-design.md`
- Review: `docs/superpowers/plans/2026-07-26-session-service-facade-cleanup.md`

**Interfaces:**
- Consumes: all focused service exports and migrated callers from Tasks 1–4
- Produces: a verified branch ready to push and open as a draft PR

- [ ] **Step 1: Run formatting and inspect its changes**

Run:

```bash
pnpm check:fix
git diff --check
git status -sb
```

Expected: Biome completes, `git diff --check` reports no whitespace errors, and only task-owned files are modified.

- [ ] **Step 2: Run the full verification suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm check
```

Expected: all commands exit successfully. Record the Vitest file/test counts and any intentional skips.

- [ ] **Step 3: Review the final diff against the design**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD -- src/backend/services/session
rg -n "from ['\"]@/backend/services/session/service/" src/backend \
  --glob '*.ts' \
  --glob '!src/backend/services/session/**'
```

Expected: the diff contains only the documented facade cleanup, and no external consumer imports session internals.

- [ ] **Step 4: Commit any formatting-only changes**

If formatting changed tracked files:

```bash
git add src/backend/app-context.ts \
  src/backend/orchestration \
  src/backend/routers/websocket \
  src/backend/server.ts \
  src/backend/server.upgrade.test.ts \
  src/backend/services/session \
  src/backend/trpc
git commit -m "Format session service cleanup"
```

If formatting made no changes, do not create an empty commit.

- [ ] **Step 5: Publish the branch and open the draft PR**

Verify `gh` availability and authentication, push the branch, and open a draft PR with a body covering the API split, behavior preservation, removed wrapper tests, and all validation commands:

```bash
gh --version
gh auth status
git push -u origin agent/cleanup-session-service-facade
```

Use the connected GitHub integration to create the draft PR against the repository's default branch. If the connector cannot infer the repository or branch, create a body file with `pr_body_file=$(mktemp)` and use `gh pr create --draft --body-file "$pr_body_file"`.
