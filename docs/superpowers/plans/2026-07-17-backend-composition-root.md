# Backend Composition Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace split backend dependency wiring with one authoritative application graph consumed by server lifecycle, tRPC, HTTP, and WebSocket transports.

**Architecture:** `src/backend/app-context.ts` becomes the single composition root and exposes immutable graph containers backed by a complete service and lifecycle dependency set. Legacy mutable bridge methods are invoked only while composing explicitly supplied instances; server startup receives an already-wired graph, and transport modules obtain long-lived dependencies only from that graph.

**Tech Stack:** TypeScript 5, Express, tRPC, `ws`, Prisma, Vitest, Biome, pnpm.

## Global Constraints

- Preserve the service-capsule barrel import and `dependsOn` rules in `src/backend/services/registry.ts`.
- Custom/test composition accepts a complete dependency graph; it must not merge `Partial` overrides with production defaults.
- `createServer` requires an application graph and must not construct or configure one.
- Runtime transport modules may import types, schemas, pure helpers, and framework utilities, but not long-lived singleton instances from services, orchestration, or `db`.
- Existing HTTP, tRPC, WebSocket, startup recovery, and shutdown behavior remains externally unchanged.
- No UI changes or screenshot capture are required.

---

### Task 1: Strict application graph and bridge composition

**Files:**
- Create: `src/backend/app-context.test.ts`
- Modify: `src/backend/app-context.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.test.ts`
- Modify: `src/backend/orchestration/event-collector.orchestrator.ts`
- Modify: `src/backend/orchestration/snapshot-reconciliation.orchestrator.ts`

**Interfaces:**
- Produces: `ApplicationServices`, `ApplicationLifecycle`, `ApplicationDependencies`, `Application`, and `createApplication(dependencies?: ApplicationDependencies): Application`.
- Produces: `BridgeServices` as a required exported type and `configureDomainBridges(services: BridgeServices): void` with no defaults.
- Produces: graph-owned event collector and snapshot reconciliation lifecycle instances that accept explicit service dependencies.
- Preserves: `type AppContext = Application` and a compatibility `createAppContext` alias while consumers migrate.

- [ ] **Step 1: Write failing composition-isolation tests**

Add tests that construct two complete fake dependency objects, call `createApplication` twice, and assert each supplied wiring/lifecycle function received only its matching services. Include an assertion that the outer graph containers are frozen:

```ts
it('wires only the complete dependency graph supplied by the caller', () => {
  const first = createApplication(createApplicationDependencies('first'));
  const second = createApplication(createApplicationDependencies('second'));

  expect(first.lifecycle.wireDomainBridges).toHaveBeenCalledWith(first.services);
  expect(second.lifecycle.wireDomainBridges).toHaveBeenCalledWith(second.services);
  expect(first.lifecycle.wireDomainBridges).not.toHaveBeenCalledWith(second.services);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.services)).toBe(true);
  expect(Object.isFrozen(first.lifecycle)).toBe(true);
});
```

Add a second test proving ACP configuration reads from the supplied `configService`, not the production singleton:

```ts
expect(dependencies.services.acpRuntimeManager.setAcpStartupTimeoutMs).toHaveBeenCalledWith(4321);
expect(dependencies.services.acpRuntimeManager.configureEnvironment).toHaveBeenCalledWith({
  preferSourceEntrypoint: true,
  childProcessEnvProvider: expect.any(Function),
});
```

- [ ] **Step 2: Run the new test and verify red**

Run: `pnpm vitest run src/backend/app-context.test.ts`

Expected: FAIL because `createApplication`, `ApplicationDependencies`, and lifecycle composition do not exist.

- [ ] **Step 3: Implement the minimal authoritative graph**

Replace partial override construction with complete dependencies and immutable containers. The central implementation must have this shape:

```ts
export type Application = {
  readonly services: Readonly<ApplicationServices>;
  readonly lifecycle: Readonly<ApplicationLifecycle>;
  readonly config: AppConfig;
};

export type ApplicationDependencies = {
  readonly services: ApplicationServices;
  readonly lifecycle: ApplicationLifecycle;
};

export function createApplication(
  dependencies: ApplicationDependencies = createDefaultApplicationDependencies()
): Application {
  const { services, lifecycle } = dependencies;
  services.acpRuntimeManager.setAcpStartupTimeoutMs?.(
    services.configService.getAcpStartupTimeoutMs()
  );
  services.acpRuntimeManager.configureEnvironment?.({
    preferSourceEntrypoint: !services.configService.isProduction(),
    childProcessEnvProvider: () => services.configService.getChildProcessEnv(),
  });
  lifecycle.wireDomainBridges(services);
  lifecycle.eventCollector.configure(services);
  lifecycle.snapshotReconciliation.configure({
    session: {
      getRuntimeSnapshot: (id) => services.sessionService.getRuntimeSnapshot(id),
      getAllPendingRequests: () => services.chatEventForwarderService.getAllPendingRequests(),
    },
  });

  return Object.freeze({
    services: Object.freeze({ ...services }),
    lifecycle: Object.freeze({ ...lifecycle }),
    config: services.configService.getSystemConfig(),
  });
}

export type AppContext = Application;
export const createAppContext = createApplication;
```

`createDefaultApplicationDependencies()` must enumerate every public long-lived instance required by domain bridge wiring, server lifecycle, and transports. `ApplicationLifecycle` must include `database`, `interceptors`, `wireDomainBridges`, `eventCollector`, `snapshotReconciliation`, and `recoverStaleArchivingWorkspaces`.

Change bridge wiring to require complete input:

```ts
export type BridgeServices = {
  autoIterationService: typeof autoIterationService;
  chatEventForwarderService: typeof chatEventForwarderService;
  chatMessageHandlerService: typeof chatMessageHandlerService;
  fixerSessionService: typeof fixerSessionService;
  getWorkspaceInitPolicy: typeof getWorkspaceInitPolicy;
  githubCLIService: typeof githubCLIService;
  kanbanStateService: typeof kanbanStateService;
  logbookService: typeof logbookService;
  periodicTaskService: typeof periodicTaskService;
  prFetchRegistry: typeof prFetchRegistry;
  prSnapshotService: typeof prSnapshotService;
  ratchetService: typeof ratchetService;
  reconciliationService: typeof reconciliationService;
  sessionDataService: typeof sessionDataService;
  sessionDomainService: typeof sessionDomainService;
  sessionService: typeof sessionService;
  startupScriptService: typeof startupScriptService;
  workspaceAccessor: typeof workspaceAccessor;
  workspaceActivityService: typeof workspaceActivityService;
  workspaceQueryService: typeof workspaceQueryService;
  workspaceSnapshotStore: typeof workspaceSnapshotStore;
  workspaceStateMachine: typeof workspaceStateMachine;
};

export function configureDomainBridges(services: BridgeServices): void {
  const {
    autoIterationService,
    chatEventForwarderService,
    chatMessageHandlerService,
    fixerSessionService,
    getWorkspaceInitPolicy,
    githubCLIService,
    kanbanStateService,
    logbookService,
    periodicTaskService,
    prFetchRegistry,
    prSnapshotService,
    ratchetService,
    reconciliationService,
    sessionDataService,
    sessionDomainService,
    sessionService,
    startupScriptService,
    workspaceAccessor,
    workspaceActivityService,
    workspaceQueryService,
    workspaceSnapshotStore,
    workspaceStateMachine,
  } = services;

  const ratchetSessionBridge: RatchetSessionBridge = {
    findSessionsByWorkspaceId: (workspaceId) =>
      sessionDataService.findAgentSessionsByWorkspaceId(workspaceId),
    isSessionRunning: (id) => sessionService.isSessionRunning(id),
    isSessionWorking: (id) => sessionService.isSessionWorking(id),
    stopSession: (id) => sessionService.stopSession(id),
    startSession: (id, options) => sessionService.startSession(id, options),
    restartSession: (id, options) => sessionService.restartSession(id, options),
    sendSessionMessage: (id, message) => sessionService.sendSessionMessage(id, message),
    injectCommittedUserMessage: (id, message) =>
      sessionDomainService.injectCommittedUserMessage(id, message),
  };

  ratchetService.configure({
    session: ratchetSessionBridge,
    github: {
      extractPRInfo: (url) => githubCLIService.extractPRInfo(url),
      getPRFullDetails: (repo, pr, signal) => githubCLIService.getPRFullDetails(repo, pr, signal),
      getReviewComments: (repo, pr, since, signal) =>
        githubCLIService.getReviewComments(repo, pr, since, signal),
      getResolvedReviewCommentIds: (repo, pr, signal) =>
        githubCLIService.getResolvedReviewCommentIds(repo, pr, signal),
      computeCIStatus: (checks) =>
        githubCLIService.computeCIStatus(
          checks?.map((check) => ({ ...check, conclusion: check.conclusion ?? undefined })) ?? null
        ),
      getAuthenticatedUsername: (signal) => githubCLIService.getAuthenticatedUsername(signal),
      fetchAndComputePRState: (prUrl) => githubCLIService.fetchAndComputePRState(prUrl),
      isRecentlyFetched: (workspaceId) => prFetchRegistry.isRecentlyFetched(workspaceId),
      isFetchInFlight: (workspaceId) => prFetchRegistry.isFetchInFlight(workspaceId),
      startFetch: (workspaceId) => prFetchRegistry.startFetch(workspaceId),
      registerFetch: (workspaceId) => prFetchRegistry.register(workspaceId),
      cancelFetch: (workspaceId) => prFetchRegistry.cancelFetch(workspaceId),
    },
    snapshot: {
      recordCIObservation: ({ workspaceId, ciStatus, failedAt, observedAt }) =>
        prSnapshotService.recordCIObservation(workspaceId, {
          ciStatus,
          failedAt,
          observedAt,
        }),
      recordCINotification: (workspaceId, notifiedAt) =>
        prSnapshotService.recordCINotification(workspaceId, notifiedAt),
      recordReviewCheck: (workspaceId, checkedAt) =>
        prSnapshotService.recordReviewCheck(workspaceId, { checkedAt }),
    },
  });
  fixerSessionService.configure({ session: ratchetSessionBridge });
}
```

Keep the remaining existing adapter implementations from lines 237–512, changing only their dependency source from the removed `resolved` fallback object to the required `services` values.

Remove `defaultServices` and make `periodicTaskService` an explicit member. Make the event collector factory instance public and remove singleton fallback merging from its instance `configure`. Split snapshot reconciliation configuration from `start()` so composition configures and server lifecycle starts it later.

- [ ] **Step 4: Run focused graph and bridge tests**

Run: `pnpm vitest run src/backend/app-context.test.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts src/backend/orchestration/event-collector.orchestrator.test.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`

Expected: PASS, with domain bridge tests using an explicit complete `BridgeServices` fixture.

- [ ] **Step 5: Commit the graph boundary**

```bash
git add src/backend/app-context.ts src/backend/app-context.test.ts src/backend/orchestration/domain-bridges.orchestrator.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts src/backend/orchestration/event-collector.orchestrator.ts src/backend/orchestration/snapshot-reconciliation.orchestrator.ts
git commit -m "Compose backend runtime graph (#1957)"
```

### Task 2: Move server lifecycle onto the application graph

**Files:**
- Modify: `src/backend/server.upgrade.test.ts`
- Modify: `src/backend/server.ts`
- Modify: `src/backend/index.ts`
- Modify: `electron/main/server-manager.ts`
- Modify: `electron/main/server-manager.test.ts`
- Modify: `src/backend/middleware/request-logger.middleware.ts`
- Modify: `src/backend/middleware/index.ts`

**Interfaces:**
- Consumes: `Application` from Task 1.
- Produces: `createServer(application: Application, requestedPort?: number): ServerInstance`.
- Preserves: `ServerInstance` start/stop/getPort/getHttpServer behavior.

- [ ] **Step 1: Change lifecycle tests to supply sentinels through the graph**

Remove module mocks for database, domain bridge configuration, event collector, reconciliation, snapshot reconciliation, periodic task, run-script state machine, workspace accessor, and interceptors. Put their spies on `context.lifecycle` or `context.services` in `createTestHarness`.

Replace the startup wiring assertion with:

```ts
it('starts an already-composed application without rewiring dependencies', async () => {
  const { application, lifecycle } = createTestHarness();
  const server = createServer(application, 0);

  await server.start();

  expect(lifecycle.wireDomainBridges).not.toHaveBeenCalled();
  expect(lifecycle.eventCollector.configure).not.toHaveBeenCalled();
  expect(lifecycle.snapshotReconciliation.configure).not.toHaveBeenCalled();
  expect(lifecycle.snapshotReconciliation.start).toHaveBeenCalledOnce();
});
```

Update cleanup assertions to check `application.lifecycle.database.$disconnect`, graph-owned orchestrators, and graph-owned interceptors.

- [ ] **Step 2: Run server and Electron tests and verify red**

Run: `pnpm vitest run src/backend/server.upgrade.test.ts electron/main/server-manager.test.ts`

Expected: FAIL because `createServer` still constructs a context, imports lifecycle singletons, and performs configure calls in `start()`.

- [ ] **Step 3: Require and consume the application graph**

Change the server signature and remove singleton imports:

```ts
export function createServer(application: Application, requestedPort?: number): ServerInstance {
  const { services, lifecycle } = application;
  const {
    interceptors,
    eventCollector,
    snapshotReconciliation,
    database,
    recoverStaleArchivingWorkspaces,
  } = lifecycle;
  // Construct HTTP/tRPC/WebSocket adapters with `application`.
}
```

In `start()`, delete all domain/event/snapshot configure calls and call only `snapshotReconciliation.start()` at its existing lifecycle point. Replace every startup/shutdown direct singleton use with `services` or `lifecycle`. Keep cleanup promise idempotence and existing recovery error handling.

Construct the application explicitly in both entrypoints:

```ts
const application = createApplication();
const serverInstance = createServer(application);
application.services.serverInstanceService.setInstance(serverInstance);
```

Electron's dynamic import must obtain `createApplication` and `createServer` from the same backend module boundary and set its graph-owned `serverInstanceService`.

Remove the module-level `requestLoggerMiddleware = createRequestLoggerMiddleware(createAppContext())` export, leaving only the factory.

- [ ] **Step 4: Run lifecycle tests**

Run: `pnpm vitest run src/backend/server.upgrade.test.ts src/backend/fatal-error-handlers.test.ts electron/main/server-manager.test.ts electron/main/lifecycle.test.ts src/backend/middleware/middleware.test.ts`

Expected: PASS. Startup tests show no wiring calls; shutdown and startup-failure cleanup use supplied graph instances exactly once.

- [ ] **Step 5: Commit lifecycle migration**

```bash
git add src/backend/server.ts src/backend/server.upgrade.test.ts src/backend/index.ts electron/main/server-manager.ts electron/main/server-manager.test.ts src/backend/middleware/request-logger.middleware.ts src/backend/middleware/index.ts
git commit -m "Route server lifecycle through application graph (#1957)"
```

### Task 3: Remove hidden WebSocket and HTTP service dependencies

**Files:**
- Modify: `src/backend/routers/health.router.ts`
- Modify: `src/backend/routers/health.router.test.ts`
- Modify: `src/backend/routers/websocket/chat-connection-registry.ts`
- Modify: `src/backend/routers/websocket/chat.handler.ts`
- Modify: `src/backend/routers/websocket/terminal.handler.ts`
- Modify: `src/backend/routers/websocket/snapshots.handler.ts`
- Modify: `src/backend/routers/websocket/dev-logs.handler.ts`
- Modify: `src/backend/routers/websocket/post-run-logs.handler.ts`
- Modify: `src/backend/routers/websocket/context-injection.test.ts`
- Modify: affected `src/backend/routers/websocket/*.test.ts` fixtures

**Interfaces:**
- Consumes: graph services `healthService`, `sessionDataService`, `workspaceDataService`, `workspaceQueryService`, `workspaceSnapshotStore`, and `snapshotReconciliation`.
- Produces: handler factories that capture all long-lived dependencies from the supplied application.

- [ ] **Step 1: Strengthen the transport source guard**

Extend `context-injection.test.ts` to scan health and WebSocket production files and reject value imports from service/orchestration/db modules:

```ts
const FORBIDDEN_RUNTIME_BINDINGS = [
  'healthService',
  'snapshotReconciliationService',
  'sessionDataService',
  'workspaceDataService',
  'workspaceQueryService',
  'workspaceSnapshotStore',
] as const;

for (const file of TRANSPORT_FILES) {
  it(`${file} resolves long-lived dependencies through the application graph`, () => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    const valueImports = source.matchAll(
      /import\s+(?!type\b)([\s\S]*?)\s+from\s+['"](@\/backend\/(?:services|orchestration|db)(?:\/[^'"]*)?)['"]/g
    );

    for (const [, bindings] of valueImports) {
      expect(bindings).not.toMatch(
        new RegExp(`\\b(?:${FORBIDDEN_RUNTIME_BINDINGS.join('|')})\\b`)
      );
    }
  });
}
```

- [ ] **Step 2: Run the guard and verify red**

Run: `pnpm vitest run src/backend/routers/websocket/context-injection.test.ts`

Expected: FAIL for health, terminal, snapshot, chat registry, and log handler direct imports.

- [ ] **Step 3: Inject each handler dependency**

At each factory boundary, destructure the required graph services. For terminal helpers, pass a narrow dependency object:

```ts
type TerminalHandlerServices = Pick<
  ApplicationServices,
  'terminalService' | 'sessionDataService' | 'workspaceDataService'
>;

export function createTerminalUpgradeHandler(application: Application) {
  const services: TerminalHandlerServices = application.services;
  // Pass `services` to create/persist/cleanup helpers.
}
```

For snapshots, use `application.services.workspaceQueryService`, `application.services.workspaceSnapshotStore`, and `application.lifecycle.snapshotReconciliation`. For health, use `application.services.healthService`. Change chat transport attachment to accept config/logger/session event dependencies from the graph. Construct module-local broadcasters lazily with the factory's logger or keep transport-owned state while eliminating service imports.

Update handler tests and the real WebSocket integration fixture so every dependency used by a handler is supplied through its application fixture.

- [ ] **Step 4: Run HTTP/WebSocket tests**

Run: `pnpm vitest run src/backend/routers/health.router.test.ts src/backend/routers/websocket/context-injection.test.ts src/backend/routers/websocket/chat-connection-registry.test.ts src/backend/routers/websocket/chat.handler.test.ts src/backend/routers/websocket/terminal.handler.test.ts src/backend/routers/websocket/snapshots.handler.test.ts src/backend/routers/websocket/dev-logs.handler.test.ts src/backend/routers/websocket/post-run-logs.handler.test.ts src/backend/routers/websocket/websocket.integration.test.ts src/backend/server.upgrade.test.ts`

Expected: PASS, including real upgrade coverage and source guards.

- [ ] **Step 5: Commit transport injection**

```bash
git add src/backend/routers/health.router.ts src/backend/routers/health.router.test.ts src/backend/routers/websocket
git commit -m "Inject HTTP and WebSocket runtime services (#1957)"
```

### Task 4: Resolve tRPC runtime dependencies through request context

**Files:**
- Modify: `src/backend/trpc/admin.trpc.ts`
- Modify: `src/backend/trpc/auto-iteration.trpc.ts`
- Modify: `src/backend/trpc/closed-sessions.trpc.ts`
- Modify: `src/backend/trpc/decision-log.trpc.ts`
- Modify: `src/backend/trpc/github.trpc.ts`
- Modify: `src/backend/trpc/linear.trpc.ts`
- Modify: `src/backend/trpc/periodic-task.trpc.ts`
- Modify: `src/backend/trpc/project.trpc.ts`
- Modify: `src/backend/trpc/session.trpc.ts`
- Modify: `src/backend/trpc/user-settings.trpc.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`
- Modify: `src/backend/trpc/workspace/git.trpc.ts`
- Modify: `src/backend/trpc/workspace/ide.trpc.ts`
- Modify: `src/backend/trpc/workspace/init.trpc.ts`
- Modify: `src/backend/trpc/workspace/run-script.trpc.ts`
- Modify: `src/backend/trpc/workspace/workspace-helpers.ts`
- Modify: corresponding `src/backend/trpc/*.test.ts` fixtures
- Create: `src/backend/trpc/context-dependencies.test.ts`

**Interfaces:**
- Consumes: `Context['appContext']['services']` and narrow service arguments in helper functions.
- Produces: tRPC procedures with no long-lived value imports from backend services, orchestration, or database modules.

- [ ] **Step 1: Add a failing tRPC source guard**

Scan all production `.trpc.ts` files and `workspace/workspace-helpers.ts`, permitting `import type` and rejecting long-lived value imports:

```ts
const FORBIDDEN_TRPC_RUNTIME_BINDINGS = [
  'autoIterationService',
  'cryptoService',
  'dataBackupService',
  'decisionLogQueryService',
  'gitCloneService',
  'githubCLIService',
  'insightsService',
  'linearClientService',
  'logbookService',
  'periodicTaskAccessor',
  'prSnapshotService',
  'projectManagementService',
  'ratchetService',
  'runScriptConfigPersistenceService',
  'sessionDataService',
  'sessionProviderResolverService',
  'userSettingsQueryService',
  'workspaceAccessor',
  'workspaceActivityService',
  'workspaceDataService',
  'workspaceNotificationAccessor',
  'workspaceQueryService',
] as const;

it.each(TRPC_RUNTIME_FILES)('%s uses context runtime dependencies', (file) => {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const valueImports = source.matchAll(
    /import\s+(?!type\b)([\s\S]*?)\s+from\s+['"](@\/backend\/(?:services|orchestration|db)(?:\/[^'"]*)?)['"]/g
  );

  for (const [, bindings] of valueImports) {
    expect(bindings).not.toMatch(
      new RegExp(`\\b(?:${FORBIDDEN_TRPC_RUNTIME_BINDINGS.join('|')})\\b`)
    );
  }
});
```

- [ ] **Step 2: Run the guard and verify red**

Run: `pnpm vitest run src/backend/trpc/context-dependencies.test.ts`

Expected: FAIL and list every router that still imports a long-lived instance.

- [ ] **Step 3: Migrate procedures and helpers**

Destructure services inside each resolver:

```ts
checkHealth: publicProcedure.query(({ ctx }) => {
  return ctx.appContext.services.githubCLIService.checkHealth();
});
```

Change shared helpers to accept context or a narrow port:

```ts
export async function getWorkspaceWithProjectOrThrow(
  workspaceDataService: ApplicationServices['workspaceDataService'],
  workspaceId: string
) {
  const workspace = await workspaceDataService.getWorkspaceWithProject(workspaceId);
  if (!workspace) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
  return workspace;
}
```

Treat constructors and orchestration functions as graph factories when they capture runtime state: expose `createFactoryConfigService`, `initializeWorkspaceWorktree`, workspace archive/child functions, and startup pipeline functions through `ApplicationServices` or a named application operations section. Pure parsing/derivation helpers may remain direct imports.

Remove module-scope loggers in tRPC modules and create them through `ctx.appContext.services.createLogger` inside the resolver or a `getLogger(ctx)` helper.

Update each router test caller fixture with the sentinel service used by that procedure and remove obsolete module singleton mocks.

- [ ] **Step 4: Run tRPC suites**

Run: `pnpm vitest run src/backend/trpc/context-dependencies.test.ts src/backend/trpc/*.test.ts src/backend/trpc/workspace/*.test.ts`

Expected: PASS. Sentinel mocks supplied in caller context receive calls; direct module singleton mocks are no longer necessary.

- [ ] **Step 5: Commit tRPC migration**

```bash
git add src/backend/app-context.ts src/backend/trpc
git commit -m "Resolve tRPC services from application context (#1957)"
```

### Task 5: Durable architecture documentation and lifecycle regression coverage

**Files:**
- Create: `docs/design/backend-composition-root.md`
- Modify: `src/backend/app-context.test.ts`
- Modify: `src/backend/server.upgrade.test.ts`
- Modify: `src/backend/routers/websocket/context-injection.test.ts`

**Interfaces:**
- Documents: graph ownership, construction, lifecycle order, transport rules, test graph construction, and staged singleton removal.
- Verifies: startup, shutdown, upgrade, bridge, isolation, and architecture boundaries required by #1957.

- [ ] **Step 1: Add final lifecycle regression assertions**

Add explicit tests that start and stop a supplied graph, stop twice, and verify graph-owned participants stop once. Add an upgrade-routing test whose handler factory sees the exact application object, and retain the graph-A/graph-B bridge isolation test from Task 1.

```ts
await server.start();
await Promise.all([server.stop(), server.stop()]);
expect(application.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
expect(application.lifecycle.eventCollector.stop).toHaveBeenCalledOnce();
expect(application.lifecycle.snapshotReconciliation.stop).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run lifecycle regression tests before documentation**

Run: `pnpm vitest run src/backend/app-context.test.ts src/backend/server.upgrade.test.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts src/backend/routers/websocket/context-injection.test.ts`

Expected: PASS.

- [ ] **Step 3: Write the durable architecture document**

Document these enforceable rules:

```markdown
## Runtime ownership

`createApplication()` is the only production composition root. It chooses runtime instances, completes legacy bridge wiring, and returns frozen graph containers.

## Lifecycle

Composition -> server construction -> bind/recover/start -> reverse cleanup. Dependency wiring never occurs in `ServerInstance.start()`.

## Transport boundary

Server, HTTP, tRPC, and WebSocket modules resolve long-lived dependencies from the supplied application graph. Source guards reject direct singleton imports.

## Tests

Custom graphs supply complete `ApplicationDependencies`; missing values never fall back to production instances.
```

Include the remaining staged work: constructor injection inside capsules, Prisma/accessor factories, event-based cycle removal, and deletion of compatibility singleton exports.

- [ ] **Step 4: Run documentation and focused checks**

Run: `pnpm vitest run src/backend/app-context.test.ts src/backend/server.upgrade.test.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts src/backend/routers/websocket/context-injection.test.ts src/backend/trpc/context-dependencies.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit documentation and regression coverage**

```bash
git add docs/design/backend-composition-root.md src/backend/app-context.test.ts src/backend/server.upgrade.test.ts src/backend/routers/websocket/context-injection.test.ts
git commit -m "Document backend dependency model (#1957)"
```

### Task 6: Verification, review, and pull request

**Files:**
- Review: all files changed from `origin/main`.
- Create outside repository: `/tmp/pr-body.md`.

**Interfaces:**
- Produces: verified branch and draft-ready pull request closing #1957.

- [ ] **Step 1: Run the required verification chain**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all commands exit 0. Review and commit any formatting changes made by `pnpm check:fix`.

- [ ] **Step 2: Run architecture-specific guardrails**

Run: `pnpm deps:check && pnpm check:service-registry && pnpm check:ownership`

Expected: all commands exit 0 with no new boundary violations.

- [ ] **Step 3: Review and simplify**

Run: `git diff --check && git diff --stat origin/main && git diff origin/main`

Inspect for direct runtime imports, debug output, stale configure calls in server startup, unsafe partial graph merges, unclear names, and redundant compatibility code. Because the change spans more than eight files, use the code-simplifier/review workflow and rerun affected tests after accepted changes.

- [ ] **Step 4: Commit verification-only changes and confirm clean state**

```bash
git add -A
git commit -m "Polish backend composition root (#1957)"
git status --short --branch
```

Expected: working tree clean and feature branch ahead of `origin/main`.

- [ ] **Step 5: Push and create the pull request**

```bash
git push -u origin HEAD
gh pr create --title "Fix #1957: Consolidate backend composition root" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

The PR body must summarize the composition root, transport/lifecycle migration, and tests; list the four required verification commands; include `Closes #1957`; and end with:

```markdown
---
🏭 Forged in [Factory Factory](https://factoryfactory.ai)
```
