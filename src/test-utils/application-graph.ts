/**
 * A complete fake application graph for unit tests.
 *
 * `services` defines only the members whose behaviour tests rely on; every
 * other `ApplicationServices` member is a per-graph auto-stub (see
 * `auto-stub.ts`), so adding a member to `ApplicationServices` needs no edit
 * here. Configure what a test exercises: assign it on `graph.services`, or
 * pass an override to the code under test. Spreading `graph.services` copies
 * only the members defined below, not the auto-stubs.
 *
 * The module mocks keep real singletons, the database and jobs out of every
 * test that imports this file, including tests that run the real
 * `createDefaultApplicationDependencies()`. Exports a mock does not name
 * resolve to auto-stubs, so a new export used by the composition root needs
 * no edit here either.
 */
import { type Mock, vi } from 'vitest';
import { createAgentAuthoring } from '@/backend/orchestration/agent-authoring.orchestrator';
import { createAgentManagement } from '@/backend/orchestration/agent-management.orchestrator';
import { applicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
import type {
  PreparedSessionLoad,
  SessionLoadDependencies,
  SessionLoadResult,
  SessionLoadService,
} from '@/backend/services/session';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const { withAutoStubs } = await vi.hoisted(() =>
  vi.importActual<typeof import('@/test-utils/auto-stub')>('@/test-utils/auto-stub')
);

const hoistedApplicationGraphMocks = vi.hoisted(() => ({
  computePendingRequestType: vi.fn(),
  deriveWorkspaceFlowStateFromWorkspace: vi.fn(),
}));

export interface ApplicationGraphMocks {
  computePendingRequestType: Mock<(...args: unknown[]) => unknown>;
  deriveWorkspaceFlowStateFromWorkspace: Mock<(...args: unknown[]) => unknown>;
}

export const applicationGraphMocks: ApplicationGraphMocks = hoistedApplicationGraphMocks;

vi.mock('@/backend/db', () => withAutoStubs('db', { prisma: { $disconnect: vi.fn() } }));
vi.mock('@/backend/interceptors', () =>
  withAutoStubs('interceptors', {
    registerInterceptors: vi.fn(),
    startInterceptors: vi.fn(),
    stopInterceptors: vi.fn(),
  })
);
vi.mock('@/backend/orchestration/application-update.service', () =>
  withAutoStubs('application-update.service', {
    ApplicationUpdateService: class {
      start = vi.fn();
      stop = vi.fn(async () => undefined);
    },
    createProcessUpdateSupervisor: vi.fn(),
  })
);
vi.mock('@/backend/services/application-update', () =>
  withAutoStubs('application-update', {
    applicationReleaseService: { getPackageRoot: () => '/installed/factory-factory' },
  })
);
vi.mock('@/backend/orchestration/cli-health.service', () =>
  withAutoStubs('cli-health.service', { cliHealthService: {} })
);
vi.mock('@/backend/orchestration/data-backup.service', () =>
  withAutoStubs('data-backup.service', { dataBackupService: {} })
);
vi.mock('@/backend/orchestration/domain-bridges.orchestrator', () =>
  withAutoStubs('domain-bridges.orchestrator', { configureDomainBridges: vi.fn() })
);
vi.mock('@/backend/orchestration/event-collector.orchestrator', () =>
  withAutoStubs('event-collector.orchestrator', {
    createEventCollectorOrchestrator: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      removeWorkspace: vi.fn(),
    })),
  })
);
vi.mock('@/backend/orchestration/linear-config.helper', () =>
  withAutoStubs('linear-config.helper', {
    getWorkspaceLinearContext: vi.fn().mockResolvedValue(null),
  })
);
vi.mock('@/backend/orchestration/reconciliation.service', () =>
  withAutoStubs('reconciliation.service', {
    reconciliationService: { stopPeriodicCleanup: vi.fn(async () => undefined) },
  })
);
vi.mock('@/backend/orchestration/scheduler.service', () =>
  withAutoStubs('scheduler.service', { schedulerService: { stop: vi.fn(async () => undefined) } })
);
vi.mock('@/backend/orchestration/snapshot-reconciliation.orchestrator', () =>
  withAutoStubs('snapshot-reconciliation.orchestrator', {
    SnapshotReconciliationService: class {
      start = vi.fn();
      stop = vi.fn(async () => undefined);
    },
  })
);
vi.mock('@/backend/orchestration/adversarial-review.orchestrator', () =>
  withAutoStubs('adversarial-review.orchestrator', { triggerAdversarialReview: vi.fn() })
);
vi.mock('@/backend/orchestration/workspace-archive.orchestrator', () =>
  withAutoStubs('workspace-archive.orchestrator', {
    archiveWorkspace: vi.fn(),
    cleanupWorkspaceRuntimeResources: vi.fn(),
    recoverStaleArchivingWorkspaces: vi.fn(),
  })
);
vi.mock('@/backend/orchestration/workspace-children.orchestrator', () =>
  withAutoStubs('workspace-children.orchestrator', {
    createChildWorkspace: vi.fn(),
    fireLifecycleNotification: vi.fn(),
    persistChildNotification: vi.fn(),
    persistParentNotification: vi.fn(),
  })
);
vi.mock('@/backend/orchestration/workspace-notification-delivery.orchestrator', () =>
  withAutoStubs('workspace-notification-delivery.orchestrator', {
    deliverWorkspaceNotification: vi.fn(),
    recoverWorkspaceMail: vi.fn().mockResolvedValue({ queued: false }),
  })
);
vi.mock('@/backend/orchestration/workspace-init.orchestrator', () =>
  withAutoStubs('workspace-init.orchestrator', {
    initializeWorkspaceWorktree: vi.fn(),
    enqueueWorkspaceInitializationTask: vi.fn((_id: string, task: () => Promise<unknown>) =>
      task()
    ),
    recoverStaleProvisioningWorkspace: vi.fn(),
    retryQueuedDispatchAfterWorkspaceReady: vi.fn(),
  })
);
vi.mock('@/backend/orchestration/workspace-retry-authority', () =>
  withAutoStubs('workspace-retry-authority', {
    captureWorkspaceRetryGuard: vi.fn(),
    readWorkspaceRetryAvailability: vi.fn(),
  })
);
vi.mock('@/backend/orchestration/workspace-init-script-pipeline', () =>
  withAutoStubs('workspace-init-script-pipeline', { executeStartupScriptPipeline: vi.fn() })
);
vi.mock('@/backend/prompts/quick-actions', () =>
  withAutoStubs('quick-actions', { getQuickAction: vi.fn(), listQuickActions: vi.fn() })
);
vi.mock('@/backend/services/codex-accounts', () =>
  withAutoStubs('codex-accounts', {
    codexAccountService: {
      getAccounts: vi.fn(async () => []),
      getEnabledAccountIds: vi.fn(async () => []),
      createAccount: vi.fn(),
      updateAccount: vi.fn(),
      getRuntimeContext: vi.fn(async (id = 'codex-native-default') => ({
        accountId: id,
        homeDir: '/tmp/.codex',
        sessionsDir: '/tmp/.codex/sessions',
        env: {},
      })),
      getPreviewRuntimeContext: vi.fn(async (options: { accountId?: string } = {}) => ({
        accountId: options.accountId ?? 'codex-native-default',
        homeDir: '/tmp/.codex',
        sessionsDir: '/tmp/.codex/sessions',
        env: {},
      })),
      withAccountReservation: vi.fn(
        async (input: { accountId?: string }, operation: (accountId: string) => Promise<unknown>) =>
          operation(input.accountId ?? 'codex-native-default')
      ),
      getUsage: vi.fn(),
      startLogin: vi.fn(),
      getLoginStatus: vi.fn(),
      cancelLogin: vi.fn(),
      shutdown: vi.fn(),
    },
  })
);
vi.mock('@/backend/services/config.service', () =>
  withAutoStubs('config.service', {
    configService: {
      getDebugConfig: () => ({ chatWebSocket: false }),
      getWorkspaceMetadataConfig: () => ({
        enabled: false,
        codexModel: 'gpt-6-luna',
        claudeModel: 'haiku',
      }),
    },
  })
);
vi.mock('@/backend/services/crypto.service', () =>
  withAutoStubs('crypto.service', { cryptoService: {} })
);
vi.mock('@/backend/services/agent-definition', () =>
  withAutoStubs('agent-definition', {
    agentProposalService: {},
    agentManagementService: {},
    triggerCapability: vi.fn(),
    slackConnectionService: {
      list: vi.fn(async () => []),
      connect: vi.fn(),
      test: vi.fn(),
      disconnect: vi.fn(),
    },
  })
);
vi.mock('@/backend/services/decision-log', () =>
  withAutoStubs('decision-log', { decisionLogService: {} })
);
vi.mock('@/backend/services/search', () =>
  withAutoStubs('search', { metadataSearchService: { search: vi.fn() } })
);
vi.mock('@/backend/services/github', () =>
  withAutoStubs('github', {
    prObservationService: { configure: vi.fn() },
    checkGithubAuth: vi.fn(),
    githubCLIService: {},
    prFetchCoordinator: {},
    prSnapshotService: {},
  })
);
vi.mock('@/backend/services/linear', () =>
  withAutoStubs('linear', { linearClientService: {}, linearStateSyncService: {} })
);
vi.mock('@/backend/services/logger.service', () =>
  withAutoStubs('logger.service', {
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    getLogFilePath: vi.fn(),
  })
);
vi.mock('@/backend/services/periodic-task', () =>
  withAutoStubs('periodic-task', { periodicTaskService: { stop: vi.fn(async () => undefined) } })
);
vi.mock('@/backend/services/port.service', () =>
  withAutoStubs('port.service', { findAvailablePort: vi.fn() })
);
vi.mock('@/backend/services/ratchet', () =>
  withAutoStubs('ratchet', { ratchetService: { stop: vi.fn(async () => undefined) } })
);
vi.mock('@/backend/services/rate-limiter.service', () =>
  withAutoStubs('rate-limiter.service', { rateLimiter: { stop: vi.fn(async () => undefined) } })
);
vi.mock('@/backend/services/run-script', () =>
  withAutoStubs('run-script', {
    createRunScriptService: vi.fn(() => ({ cleanup: vi.fn(async () => undefined) })),
    FactoryConfigService: { readConfig: vi.fn() },
    runScriptConfigPersistenceService: {},
    runScriptStateMachine: {},
    startupScriptService: {},
  })
);
vi.mock('@/backend/services/server-instance.service', () =>
  withAutoStubs('server-instance.service', {
    createServerInstanceService: vi.fn(() => ({})),
    serverInstanceService: {},
  })
);
vi.mock('@/backend/services/session', async () => {
  const { sessionCommandFactories } = await vi.importActual<
    typeof import('@/backend/services/session/service/chat/session-command-factories')
  >('@/backend/services/session/service/chat/session-command-factories');
  return withAutoStubs('session', {
    sessionBackgroundDeliveryService: { configure: vi.fn() },
    findPRDeliveryReceipt: vi.fn(),
    acpRuntimeManager: {},
    acpTraceLogger: { cleanup: vi.fn() },
    chatEventForwarderService: {},
    createSessionLoadService: vi.fn(
      (ports: Pick<SessionLoadDependencies, 'getRuntimeSnapshot'>) =>
        ({
          prepareLoad: vi.fn(
            (input: { sessionId: string; loadRequestId?: string }): Promise<SessionLoadResult> =>
              Promise.resolve({
                status: 'ready',
                ...input,
                provider: 'CODEX',
                worktreePath: null,
              })
          ),
          captureReplay: vi.fn((prepared: PreparedSessionLoad) => {
            const sessionRuntime = ports.getRuntimeSnapshot(prepared.sessionId);
            return {
              replayEvents: [{ type: 'session_runtime_snapshot' as const, sessionRuntime }],
              sessionRuntime,
            };
          }),
          completeLoad: vi.fn((_prepared: PreparedSessionLoad): Promise<void> => Promise.resolve()),
        }) satisfies Pick<SessionLoadService, 'prepareLoad' | 'captureReplay' | 'completeLoad'>
    ),
    sessionCommandFactories,
    sessionConfigService: {},
    sessionPermissionService: {},
    sessionDispatchService: {},
    claudeModelCatalogService: { getModels: vi.fn() },
    codexModelCatalogService: { getModels: vi.fn() },
    providerUsageService: { getUsage: vi.fn() },
    createSessionDataService: vi.fn(() => ({})),
    sessionDataService: {},
    sessionDomainService: {},
    sessionEventBus: unsafeCoerce({ publishToSession: vi.fn() }),
    sessionFileLogger: { log: vi.fn(), cleanup: vi.fn() },
    sessionLifecycleEventService: {},
    sessionLifecycleService: {
      stopAllClients: vi.fn().mockResolvedValue(undefined),
      getRuntimeSnapshot: vi.fn(() => ({
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: '2026-10-27T00:00:00Z',
      })),
    },
    createSessionProviderResolverService: vi.fn(() => ({})),
    sessionProviderResolverService: {},
    sessionPromptTurnCompletionService: {},
    sessionRepository: {},
    sessionService: {},
    voiceNarrationService: {},
  });
});
vi.mock('@/backend/services/settings', () =>
  withAutoStubs('settings', { settingsHealthService: {}, userSettingsService: {} })
);
vi.mock('@/backend/services/terminal', () =>
  withAutoStubs('terminal', { terminalService: { cleanup: vi.fn() }, terminalSessionService: {} })
);
vi.mock('@/backend/services/workspace', async () =>
  withAutoStubs('workspace', {
    ...(await vi.importActual('@/backend/services/workspace/service/state/workspace-read-state')),
    workspacePRMonitoringService: { get: vi.fn(), listLegacyRetirementCandidates: vi.fn() },
    computePendingRequestType: (...args: unknown[]) =>
      applicationGraphMocks.computePendingRequestType(...args),
    deriveWorkspaceFlowStateFromWorkspace: (...args: unknown[]) =>
      applicationGraphMocks.deriveWorkspaceFlowStateFromWorkspace(...args),
    getWorkspaceInitPolicy: vi.fn(),
    gitCloneService: {},
    gitOpsService: {},
    projectManagementService: {},
    WorkspaceCreationService: class {},
    workspaceActivityService: {},
    workspaceDataService: {},
    workspaceMaintenanceService: {},
    workspaceNotificationService: {},
    workspacePrSnapshotService: {},
    workspaceQueryService: {},
    workspaceRelationshipsService: {},
    workspaceRunScriptService: {},
    workspaceSnapshotStore: {},
    workspaceStateMachine: {},
    worktreeLifecycleService: {},
    orphanedWorktreeService: {},
  })
);
vi.mock('@/backend/services/workspace-git-state.service', () =>
  withAutoStubs('workspace-git-state.service', { workspaceGitStateService: { stop: vi.fn() } })
);

import type {
  ApplicationDependencies,
  ApplicationLifecycle,
  ApplicationServices,
} from '@/backend/app-context';
import { prisma } from '@/backend/db';
import { registerInterceptors, startInterceptors, stopInterceptors } from '@/backend/interceptors';
import type { configureDomainBridges } from '@/backend/orchestration/domain-bridges.orchestrator';
import {
  createEventCollectorOrchestrator,
  type EventCollectorOrchestrator,
} from '@/backend/orchestration/event-collector.orchestrator';
import { getWorkspaceLinearContext } from '@/backend/orchestration/linear-config.helper';
import { SnapshotReconciliationService } from '@/backend/orchestration/snapshot-reconciliation.orchestrator';
import { recoverStaleArchivingWorkspaces } from '@/backend/orchestration/workspace-archive.orchestrator';
import { enqueueWorkspaceInitializationTask } from '@/backend/orchestration/workspace-init.orchestrator';
import { recoverWorkspaceMail } from '@/backend/orchestration/workspace-notification-delivery.orchestrator';
import { slackConnectionService } from '@/backend/services/agent-definition';
import { codexAccountService } from '@/backend/services/codex-accounts';
import { configService } from '@/backend/services/config.service';
import { JobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import { PortShareService } from '@/backend/services/port-share';
import {
  acpRuntimeManager,
  chatEventForwarderService,
  createSessionLoadService,
  sessionCommandFactories,
  sessionLifecycleService,
} from '@/backend/services/session';
import { computePendingRequestType } from '@/backend/services/workspace';

const fakeSystemConfig = {
  baseDir: '/tmp/factory-factory',
  worktreeBaseDir: '/tmp/factory-factory/worktrees',
  reposDir: '/tmp/factory-factory/repos',
  debugLogDir: '/tmp/factory-factory/debug',
  acpTraceLogsPath: '/tmp/factory-factory/debug/acp-events',
  claudeConfigDir: '/tmp/.claude',
  codexHome: '/tmp/.codex',
  codexSessionsDir: '/tmp/.codex/sessions',
  wsLogsPath: '/tmp/factory-factory/ws-logs',
  nodeExecPath: '/usr/local/bin/node',
  backendPort: 3001,
  nodeEnv: 'test' as const,
  shellPath: '/bin/sh',
  databasePath: '/tmp/factory-factory/data.db',
  healthCheckIntervalMs: 1000,
  websocketMaxFrameBytes: 33_554_432,
  maxSessionsPerWorkspace: 2,
  prDiscovery: { candidateLimit: 50, repositoryLimit: 10 },
  logger: { level: 'debug' as const, prettyPrint: false, serviceName: 'test' },
  rateLimiter: {
    claudeRequestsPerMinute: 10,
    claudeRequestsPerHour: 100,
    maxQueueSize: 10,
    queueTimeoutMs: 1000,
  },
  notification: { soundEnabled: false, pushEnabled: false },
  cors: { allowedOrigins: [] },
  debug: { chatWebSocket: false },
  acpStartupTimeoutMs: 4321,
  acpTraceLogsEnabled: false,
  wsLogsEnabled: false,
  runScriptProxyEnabled: false,
  emitBackendPort: false,
  tailscale: null,
  compression: { enabled: false },
  workspaceMetadata: { enabled: false, codexModel: 'gpt-6-luna', claudeModel: 'haiku' },
  appVersion: 'test',
};

export interface FakeApplicationGraph extends ApplicationDependencies {
  config: typeof fakeSystemConfig;
}

export function createFakeApplicationGraph(label = 'test'): FakeApplicationGraph {
  let graphEventCollector: EventCollectorOrchestrator | null = null;
  const graphSystemConfig = structuredClone(fakeSystemConfig);
  const graphSessionLifecycleService = Object.assign({}, sessionLifecycleService, {
    getRuntimeSnapshot: vi.fn(() => createInitialSessionRuntimeState()),
  }) satisfies typeof sessionLifecycleService;

  // Only members with behaviour a test relies on; everything else is auto-stubbed.
  const services: ApplicationServices = withAutoStubs<ApplicationServices>(`graph:${label}`, {
    applicationUpdateAdmission,
    applicationUpdateService: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      checkUpdates: vi.fn(async () => ({
        currentVersion: '1.0.0',
        notices: [],
        automaticUpdate: false,
        manualCommand: 'npm install -g factory-factory@latest',
        status: { phase: 'idle' as const },
      })),
      requestUpdate: vi.fn(async () => ({ phase: 'waiting' as const })),
      cancelUpdate: vi.fn(async () => ({ phase: 'idle' as const })),
    },
    listVisibleReviewRequests: vi.fn(async () => []),
    acpRuntimeManager: Object.assign({}, acpRuntimeManager, {
      setAcpStartupTimeoutMs: vi.fn(),
      configureEnvironment: vi.fn(),
    }) satisfies typeof acpRuntimeManager,
    chatEventForwarderService: Object.assign({}, chatEventForwarderService, {
      getAllPendingRequests: vi.fn(() => new Map()),
    }) satisfies typeof chatEventForwarderService,
    sessionCommandFactories,
    sessionLoadService: createSessionLoadService(
      unsafeCoerce<Parameters<typeof createSessionLoadService>[0]>({
        getRuntimeSnapshot: (id: string) => graphSessionLifecycleService.getRuntimeSnapshot(id),
      })
    ),
    sessionLifecycleService: graphSessionLifecycleService,
    sessionEventBus: unsafeCoerce({ publishToSession: vi.fn() }),
    cleanupWorkspaceScopedCaches: (workspaceId: string) =>
      graphEventCollector?.removeWorkspace(workspaceId),
    configService: Object.assign({}, configService, {
      getAcpStartupTimeoutMs: vi.fn(() => 4321),
      isProduction: vi.fn(() => false),
      getChildProcessEnv: vi.fn(() => ({ APPLICATION_LABEL: label })),
      getSystemConfig: vi.fn(() => graphSystemConfig),
      getWorktreeBaseDir: vi.fn(() => graphSystemConfig.worktreeBaseDir),
      getWebSocketConfig: vi.fn(() => ({
        maxFrameBytes: graphSystemConfig.websocketMaxFrameBytes,
      })),
      getMaxSessionsPerWorkspace: vi.fn(() => graphSystemConfig.maxSessionsPerWorkspace),
      getCorsConfig: vi.fn(() => graphSystemConfig.cors),
    }) satisfies typeof configService,
    codexAccountService,
    computePendingRequestType,
    recoverWorkspaceMail,
    enqueueWorkspaceInitializationTask,
    getWorkspaceLinearContext,
    slackConnectionService,
    createLogger,
    createWorkspaceCreationService: () => ({ create: vi.fn() }),
    acceptWorkspaceFollowUp: vi.fn().mockResolvedValue(undefined),
    searchGitHubIssues: vi.fn().mockResolvedValue({ results: [], errors: [] }),
    agentAuthoring: createAgentAuthoring(() => services),
    agentManagement: createAgentManagement(() => services),
    agentRuntime: {
      hasWork: vi.fn(() => false),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      recovery: undefined,
    },
    portShareService: new PortShareService({
      getTailscaleConfig: () => null,
      // No record file: graph disposal must not touch the filesystem.
      records: unsafeCoerce({ write: vi.fn(async () => undefined) }),
    }),
    // Optional: absent unless workspace metadata generation is enabled.
    workspaceMetadata: undefined,
  });

  graphEventCollector = createEventCollectorOrchestrator(services);

  const lifecycle = {
    database: prisma,
    jobs: { stopAll: vi.fn(async () => undefined) },
    interceptors: {
      register: registerInterceptors,
      start: startInterceptors,
      stop: stopInterceptors,
    },
    wireDomainBridges: vi.fn<typeof configureDomainBridges>(),
    eventCollector: graphEventCollector,
    snapshotReconciliation: new SnapshotReconciliationService({
      createLogger: services.createLogger,
      gitOpsService: services.gitOpsService,
      session: {
        getRuntimeSnapshot: services.sessionLifecycleService.getRuntimeSnapshot,
        getAllPendingRequests: services.chatEventForwarderService.getAllPendingRequests,
      },
      workspaceMaintenanceService: services.workspaceMaintenanceService,
      workspaceSnapshotStore: services.workspaceSnapshotStore,
      // Its own runner, not the process-wide one. Job names are global, so two
      // graphs built in one test process would otherwise register the same job
      // and the first graph's `start()` would drive the second graph's service.
      jobRunner: new JobRunner(),
    }),
    recoverStaleArchivingWorkspaces,
  } satisfies ApplicationLifecycle;

  return { services, lifecycle, config: graphSystemConfig };
}
