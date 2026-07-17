import { type Mock, vi } from 'vitest';

const hoistedApplicationGraphMocks = vi.hoisted(() => ({
  computeKanbanColumn: vi.fn(),
  computePendingRequestType: vi.fn(),
  deriveWorkspaceFlowStateFromWorkspace: vi.fn(),
}));

export interface ApplicationGraphMocks {
  computeKanbanColumn: Mock<(...args: unknown[]) => unknown>;
  computePendingRequestType: Mock<(...args: unknown[]) => unknown>;
  deriveWorkspaceFlowStateFromWorkspace: Mock<(...args: unknown[]) => unknown>;
}

export const applicationGraphMocks: ApplicationGraphMocks = hoistedApplicationGraphMocks;

vi.mock('@/backend/db', () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock('@/backend/interceptors', () => ({
  registerInterceptors: vi.fn(),
  startInterceptors: vi.fn(),
  stopInterceptors: vi.fn(),
}));
vi.mock('@/backend/orchestration/cli-health.service', () => ({ cliHealthService: {} }));
vi.mock('@/backend/orchestration/data-backup.service', () => ({ dataBackupService: {} }));
vi.mock('@/backend/orchestration/domain-bridges.orchestrator', () => ({
  configureDomainBridges: vi.fn(),
}));
vi.mock('@/backend/orchestration/event-collector.orchestrator', () => ({
  createEventCollectorOrchestrator: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    removeWorkspace: vi.fn(),
  })),
}));
vi.mock('@/backend/orchestration/health.service', () => ({ healthService: {} }));
vi.mock('@/backend/orchestration/linear-config.helper', () => ({
  getWorkspaceLinearContext: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/backend/orchestration/reconciliation.service', () => ({ reconciliationService: {} }));
vi.mock('@/backend/orchestration/scheduler.service', () => ({ schedulerService: {} }));
vi.mock('@/backend/orchestration/snapshot-reconciliation.orchestrator', () => ({
  SnapshotReconciliationService: class {
    start = vi.fn();
    stop = vi.fn(async () => undefined);
  },
}));
vi.mock('@/backend/orchestration/workspace-archive.orchestrator', () => ({
  archiveWorkspace: vi.fn(),
  cleanupWorkspaceRuntimeResources: vi.fn(),
  recoverStaleArchivingWorkspaces: vi.fn(),
}));
vi.mock('@/backend/orchestration/workspace-children.orchestrator', () => ({
  createChildWorkspace: vi.fn(),
  fireLifecycleNotification: vi.fn(),
  persistChildNotification: vi.fn(),
  persistParentNotification: vi.fn(),
}));
vi.mock('@/backend/orchestration/workspace-notification-delivery.orchestrator', () => ({
  deliverWorkspaceNotification: vi.fn(),
}));
vi.mock('@/backend/orchestration/workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: vi.fn(),
  retryQueuedDispatchAfterWorkspaceReady: vi.fn(),
}));
vi.mock('@/backend/orchestration/workspace-init-script-pipeline', () => ({
  executeStartupScriptPipeline: vi.fn(),
}));
vi.mock('@/backend/prompts/quick-actions', () => ({
  getQuickAction: vi.fn(),
  listQuickActions: vi.fn(),
}));
vi.mock('@/backend/services/auto-iteration', () => ({
  autoIterationService: {},
  insightsService: {},
  logbookService: {},
}));
vi.mock('@/backend/services/config.service', () => ({ configService: {} }));
vi.mock('@/backend/services/crypto.service', () => ({ cryptoService: {} }));
vi.mock('@/backend/services/decision-log', () => ({ decisionLogService: {} }));
vi.mock('@/backend/services/github', () => ({
  githubCLIService: {},
  prFetchRegistry: {},
  prSnapshotService: {},
}));
vi.mock('@/backend/services/linear', () => ({
  linearClientService: {},
  linearStateSyncService: {},
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  getLogFilePath: vi.fn(),
}));
vi.mock('@/backend/services/periodic-task', () => ({
  periodicTaskService: {},
}));
vi.mock('@/backend/services/port.service', () => ({ findAvailablePort: vi.fn() }));
vi.mock('@/backend/services/ratchet', () => ({ fixerSessionService: {}, ratchetService: {} }));
vi.mock('@/backend/services/rate-limiter.service', () => ({ rateLimiter: {} }));
vi.mock('@/backend/services/run-script', () => ({
  createRunScriptService: vi.fn(() => ({})),
  FactoryConfigService: { readConfig: vi.fn() },
  runScriptConfigPersistenceService: {},
  runScriptStateMachine: {},
  startupScriptService: {},
}));
vi.mock('@/backend/services/server-instance.service', () => ({
  createServerInstanceService: vi.fn(() => ({})),
}));
vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: {},
  acpTraceLogger: {},
  chatEventForwarderService: {},
  chatMessageHandlerService: {},
  fetchCodexModelCatalogFromAppServer: vi.fn(),
  sessionDataService: {},
  sessionDomainService: {},
  sessionEventBus: {},
  sessionFileLogger: {},
  sessionProviderResolverService: {},
  sessionService: {},
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));
vi.mock('@/backend/services/terminal', () => ({
  terminalService: {},
  terminalSessionService: {},
}));
vi.mock('@/backend/services/workspace', () => ({
  computeKanbanColumn: (...args: unknown[]) => applicationGraphMocks.computeKanbanColumn(...args),
  computePendingRequestType: (...args: unknown[]) =>
    applicationGraphMocks.computePendingRequestType(...args),
  deriveWorkspaceFlowStateFromWorkspace: (...args: unknown[]) =>
    applicationGraphMocks.deriveWorkspaceFlowStateFromWorkspace(...args),
  getWorkspaceInitPolicy: vi.fn(),
  gitCloneService: {},
  gitOpsService: {},
  kanbanStateService: {},
  projectManagementService: {},
  WorkspaceCreationService: class {},
  workspaceActivityService: {},
  workspaceAutoIterationService: {},
  workspaceDataService: {},
  workspaceMaintenanceService: {},
  workspaceNotificationService: {},
  workspacePrSnapshotService: {},
  workspaceQueryService: {},
  workspaceRatchetService: {},
  workspaceRelationshipsService: {},
  workspaceRunScriptService: {},
  workspaceSnapshotStore: {},
  workspaceStateMachine: {},
  worktreeLifecycleService: {},
}));
vi.mock('@/backend/services/workspace-git-state.service', () => ({
  workspaceGitStateService: { stop: vi.fn() },
}));

import type {
  ApplicationDependencies,
  ApplicationLifecycle,
  ApplicationServices,
} from '@/backend/app-context';
import { prisma } from '@/backend/db';
import { registerInterceptors, startInterceptors, stopInterceptors } from '@/backend/interceptors';
import { cliHealthService } from '@/backend/orchestration/cli-health.service';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import type { configureDomainBridges } from '@/backend/orchestration/domain-bridges.orchestrator';
import {
  createEventCollectorOrchestrator,
  type EventCollectorOrchestrator,
} from '@/backend/orchestration/event-collector.orchestrator';
import { healthService } from '@/backend/orchestration/health.service';
import { getWorkspaceLinearContext } from '@/backend/orchestration/linear-config.helper';
import { reconciliationService } from '@/backend/orchestration/reconciliation.service';
import { schedulerService } from '@/backend/orchestration/scheduler.service';
import { SnapshotReconciliationService } from '@/backend/orchestration/snapshot-reconciliation.orchestrator';
import {
  archiveWorkspace,
  cleanupWorkspaceRuntimeResources,
  recoverStaleArchivingWorkspaces,
} from '@/backend/orchestration/workspace-archive.orchestrator';
import {
  createChildWorkspace,
  fireLifecycleNotification,
  persistChildNotification,
  persistParentNotification,
} from '@/backend/orchestration/workspace-children.orchestrator';
import {
  initializeWorkspaceWorktree,
  retryQueuedDispatchAfterWorkspaceReady,
} from '@/backend/orchestration/workspace-init.orchestrator';
import { executeStartupScriptPipeline } from '@/backend/orchestration/workspace-init-script-pipeline';
import { deliverWorkspaceNotification } from '@/backend/orchestration/workspace-notification-delivery.orchestrator';
import { getQuickAction, listQuickActions } from '@/backend/prompts/quick-actions';
import {
  autoIterationService,
  insightsService,
  logbookService,
} from '@/backend/services/auto-iteration';
import { configService } from '@/backend/services/config.service';
import { cryptoService } from '@/backend/services/crypto.service';
import { decisionLogService } from '@/backend/services/decision-log';
import { githubCLIService, prFetchRegistry, prSnapshotService } from '@/backend/services/github';
import { linearClientService, linearStateSyncService } from '@/backend/services/linear';
import { createLogger, getLogFilePath } from '@/backend/services/logger.service';
import { periodicTaskService } from '@/backend/services/periodic-task';
import { findAvailablePort } from '@/backend/services/port.service';
import { fixerSessionService, ratchetService } from '@/backend/services/ratchet';
import { rateLimiter } from '@/backend/services/rate-limiter.service';
import {
  createRunScriptService,
  FactoryConfigService,
  runScriptConfigPersistenceService,
  runScriptStateMachine,
  startupScriptService,
} from '@/backend/services/run-script';
import { createServerInstanceService } from '@/backend/services/server-instance.service';
import {
  acpRuntimeManager,
  acpTraceLogger,
  chatEventForwarderService,
  chatMessageHandlerService,
  fetchCodexModelCatalogFromAppServer,
  sessionDataService,
  sessionDomainService,
  sessionEventBus,
  sessionFileLogger,
  sessionProviderResolverService,
  sessionService,
} from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import { terminalService, terminalSessionService } from '@/backend/services/terminal';
import {
  computePendingRequestType,
  getWorkspaceInitPolicy,
  gitCloneService,
  gitOpsService,
  kanbanStateService,
  projectManagementService,
  workspaceActivityService,
  workspaceAutoIterationService,
  workspaceDataService,
  workspaceMaintenanceService,
  workspaceNotificationService,
  workspacePrSnapshotService,
  workspaceQueryService,
  workspaceRatchetService,
  workspaceRelationshipsService,
  workspaceRunScriptService,
  workspaceSnapshotStore,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { workspaceGitStateService } from '@/backend/services/workspace-git-state.service';

const fakeSystemConfig = {
  baseDir: '/tmp/factory-factory',
  worktreeBaseDir: '/tmp/factory-factory/worktrees',
  reposDir: '/tmp/factory-factory/repos',
  debugLogDir: '/tmp/factory-factory/debug',
  acpTraceLogsPath: '/tmp/factory-factory/debug/acp-events',
  claudeConfigDir: '/tmp/.claude',
  wsLogsPath: '/tmp/factory-factory/ws-logs',
  backendPort: 3001,
  nodeEnv: 'test' as const,
  shellPath: '/bin/sh',
  databasePath: '/tmp/factory-factory/data.db',
  defaultSessionProfile: {
    model: 'test',
    permissionMode: 'strict' as const,
    maxTokens: 1000,
    temperature: 0,
  },
  healthCheckIntervalMs: 1000,
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
  compression: { enabled: false },
  branchRenameMessageThreshold: 5,
  appVersion: 'test',
};

export interface FakeApplicationGraph extends ApplicationDependencies {
  config: typeof fakeSystemConfig;
}

export function createFakeApplicationGraph(label = 'test'): FakeApplicationGraph {
  let graphEventCollector: EventCollectorOrchestrator | null = null;
  const graphSystemConfig = structuredClone(fakeSystemConfig);
  const graphAcpRuntimeManager = Object.assign({}, acpRuntimeManager, {
    setAcpStartupTimeoutMs: vi.fn(),
    configureEnvironment: vi.fn(),
  }) satisfies typeof acpRuntimeManager;
  const graphConfigService = Object.assign({}, configService, {
    getAcpStartupTimeoutMs: vi.fn(() => 4321),
    isProduction: vi.fn(() => false),
    getChildProcessEnv: vi.fn(() => ({ APPLICATION_LABEL: label })),
    getSystemConfig: vi.fn(() => graphSystemConfig),
    getWorktreeBaseDir: vi.fn(() => graphSystemConfig.worktreeBaseDir),
    getMaxSessionsPerWorkspace: vi.fn(() => graphSystemConfig.maxSessionsPerWorkspace),
    getCorsConfig: vi.fn(() => graphSystemConfig.cors),
  }) satisfies typeof configService;
  const graphSessionService = Object.assign({}, sessionService, {
    getRuntimeSnapshot: vi.fn(),
  }) satisfies typeof sessionService;
  const graphChatEventForwarderService = Object.assign({}, chatEventForwarderService, {
    getAllPendingRequests: vi.fn(() => new Map()),
  }) satisfies typeof chatEventForwarderService;

  const services = {
    acpRuntimeManager: graphAcpRuntimeManager,
    acpTraceLogger,
    autoIterationService,
    archiveWorkspace,
    chatEventForwarderService: graphChatEventForwarderService,
    chatMessageHandlerService,
    cleanupWorkspaceRuntimeResources,
    cleanupWorkspaceScopedCaches: (workspaceId: string) =>
      graphEventCollector?.removeWorkspace(workspaceId),
    cliHealthService,
    configService: graphConfigService,
    computePendingRequestType,
    createChildWorkspace,
    deliverWorkspaceNotification,
    createLogger,
    createWorkspaceCreationService: () => ({ create: vi.fn() }),
    cryptoService,
    dataBackupService,
    decisionLogQueryService: decisionLogService,
    executeStartupScriptPipeline,
    factoryConfigService: FactoryConfigService,
    fetchCodexModelCatalogFromAppServer,
    findAvailablePort,
    fireLifecycleNotification,
    fixerSessionService,
    getLogFilePath,
    getQuickAction,
    getWorkspaceLinearContext,
    getWorkspaceInitPolicy,
    gitCloneService,
    gitOpsService,
    githubCLIService,
    healthService,
    initializeWorkspaceWorktree,
    insightsService,
    kanbanStateService,
    linearClientService,
    linearStateSyncService,
    listQuickActions,
    logbookService,
    periodicTaskService,
    persistChildNotification,
    persistParentNotification,
    prFetchRegistry,
    prSnapshotService,
    projectManagementService,
    rateLimiter,
    ratchetService,
    reconciliationService,
    retryQueuedDispatchAfterWorkspaceReady,
    runScriptConfigPersistenceService,
    runScriptService: createRunScriptService({ registerShutdownHandlers: false }),
    runScriptStateMachine,
    schedulerService,
    serverInstanceService: createServerInstanceService(),
    sessionDataService,
    sessionDomainService,
    sessionEventBus,
    sessionFileLogger,
    sessionProviderResolverService,
    sessionService: graphSessionService,
    startupScriptService,
    terminalService,
    terminalSessionService,
    userSettingsQueryService: userSettingsService,
    workspaceActivityService,
    workspaceAutoIterationService,
    workspaceCreationService: {
      create: vi.fn(),
    } as unknown as ApplicationServices['workspaceCreationService'],
    workspaceDataService,
    workspaceMaintenanceService,
    workspaceGitStateService,
    workspaceNotificationService,
    workspacePrSnapshotService,
    workspaceQueryService,
    workspaceRatchetService,
    workspaceRelationshipsService,
    workspaceRunScriptService,
    workspaceSnapshotStore,
    workspaceStateMachine,
    worktreeLifecycleService,
  } satisfies ApplicationServices;

  graphEventCollector = createEventCollectorOrchestrator(services);

  const lifecycle = {
    database: prisma,
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
        getRuntimeSnapshot: services.sessionService.getRuntimeSnapshot,
        getAllPendingRequests: services.chatEventForwarderService.getAllPendingRequests,
      },
      workspaceMaintenanceService: services.workspaceMaintenanceService,
      workspaceSnapshotStore: services.workspaceSnapshotStore,
    }),
    recoverStaleArchivingWorkspaces,
  } satisfies ApplicationLifecycle;

  return { services, lifecycle, config: graphSystemConfig };
}
