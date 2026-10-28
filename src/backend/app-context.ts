import { prisma } from './db';
import { registerInterceptors, startInterceptors, stopInterceptors } from './interceptors';
import { triggerAdversarialReview } from './orchestration/adversarial-review.orchestrator';
import { cliHealthService } from './orchestration/cli-health.service';
import { dataBackupService } from './orchestration/data-backup.service';
import {
  type BridgeServices,
  configureDomainBridges,
} from './orchestration/domain-bridges.orchestrator';
import {
  createEventCollectorOrchestrator,
  type EventCollectorOrchestrator,
} from './orchestration/event-collector.orchestrator';
import { healthService } from './orchestration/health.service';
import { getWorkspaceLinearContext } from './orchestration/linear-config.helper';
import { updateProjectSettings } from './orchestration/project-settings.orchestrator';
import { reconciliationService } from './orchestration/reconciliation.service';
import { schedulerService } from './orchestration/scheduler.service';
import { SnapshotReconciliationService } from './orchestration/snapshot-reconciliation.orchestrator';
import {
  archiveWorkspace,
  cleanupWorkspaceRuntimeResources,
  recoverStaleArchivingWorkspaces,
} from './orchestration/workspace-archive.orchestrator';
import {
  createChildWorkspace,
  fireLifecycleNotification,
  persistChildNotification,
  persistParentNotification,
} from './orchestration/workspace-children.orchestrator';
import { executeStartupScriptPipeline } from './orchestration/workspace-init-script-pipeline';
import {
  initializeWorkspaceWorktree,
  recoverStaleProvisioningWorkspace,
  retryQueuedDispatchAfterWorkspaceReady,
} from './orchestration/workspace-init.orchestrator';
import { launchWorkspace } from './orchestration/workspace-launch.orchestrator';
import { deliverWorkspaceNotification } from './orchestration/workspace-notification-delivery.orchestrator';
import { createWorkspaceRename } from './orchestration/workspace-rename.orchestrator';
import { getQuickAction, listQuickActions } from './prompts/quick-actions';
import { autoIterationService, insightsService, logbookService } from './services/auto-iteration';
import { configService } from './services/config.service';
import { cryptoService } from './services/crypto.service';
import { decisionLogService } from './services/decision-log';
import {
  checkGithubAuth,
  githubCLIService,
  prFetchCoordinator,
  prSnapshotService,
  prObservationService,
} from './services/github';
import { linearClientService, linearStateSyncService } from './services/linear';
import { createLogger, getLogFilePath } from './services/logger.service';
import { periodicTaskService } from './services/periodic-task';
import { findAvailablePort } from './services/port.service';
import { ratchetService } from './services/ratchet';
import { rateLimiter } from './services/rate-limiter.service';
import {
  createRunScriptService,
  FactoryConfigService,
  type RunScriptService,
  runScriptConfigPersistenceService,
  runScriptStateMachine,
  startupScriptService,
} from './services/run-script';
import { metadataSearchService } from './services/search';
import {
  type ServerInstanceService,
  serverInstanceService,
} from './services/server-instance.service';
import {
  type AcpTraceLogger,
  acpRuntimeManager,
  acpTraceLogger,
  chatEventForwarderService,
  createSessionLoadService,
  createSessionDataService,
  createSessionProviderResolverService,
  sessionCommandFactories,
  sessionConfigService,
  sessionPermissionService,
  sessionDispatchService,
  claudeModelCatalogService,
  codexModelCatalogService,
  providerUsageService,
  type SessionFileLogger,
  sessionBackgroundDeliveryService,
  findPRDeliveryReceipt,
  sessionDomainService,
  sessionEventBus,
  sessionFileLogger,
  sessionLifecycleEventService,
  sessionLifecycleService,
  sessionPromptTurnCompletionService,
  type sessionProviderResolverService,
  sessionRepository,
  sessionService,
  voiceNarrationService,
} from './services/session';
import { userSettingsService } from './services/settings';
import { terminalService, terminalSessionService } from './services/terminal';
import {
  computePendingRequestType,
  getWorkspaceInitPolicy,
  gitCloneService,
  gitOpsService,
  orphanedWorktreeService,
  projectManagementService,
  WorkspaceCreationService,
  workspaceActivityService,
  workspaceAutoIterationService,
  workspaceDataService,
  workspaceMaintenanceService,
  workspaceNotificationService,
  workspacePrSnapshotService,
  workspacePRMonitoringService,
  workspaceQueryService,
  workspaceRelationshipsService,
  workspaceRunScriptService,
  workspaceSnapshotStore,
  workspaceStateMachine,
  worktreeLifecycleService,
} from './services/workspace';
import { workspaceGitStateService } from './services/workspace-git-state.service';

export type ApplicationServices = BridgeServices & {
  sessionDispatchService: Pick<
    typeof sessionDispatchService,
    'configure' | 'tryDispatchNextMessage' | 'setManualDispatchResume' | 'resetDispatchState'
  >;
  acpRuntimeManager: typeof acpRuntimeManager;
  acpTraceLogger: AcpTraceLogger;
  sessionLoadService: ReturnType<typeof createSessionLoadService>;
  sessionCommandFactories: typeof sessionCommandFactories;
  sessionConfigService: typeof sessionConfigService;
  sessionPermissionService: typeof sessionPermissionService;
  checkGithubAuth: typeof checkGithubAuth;
  cliHealthService: typeof cliHealthService;
  configService: typeof configService;
  cryptoService: typeof cryptoService;
  createLogger: typeof createLogger;
  dataBackupService: typeof dataBackupService;
  decisionLogQueryService: typeof decisionLogService;
  metadataSearchService: typeof metadataSearchService;
  executeStartupScriptPipeline: typeof executeStartupScriptPipeline;
  claudeModelCatalogService: Pick<typeof claudeModelCatalogService, 'getModels'>;
  codexModelCatalogService: Pick<typeof codexModelCatalogService, 'getModels'>;
  providerUsageService: Pick<typeof providerUsageService, 'getUsage'>;
  factoryConfigService: Pick<typeof FactoryConfigService, 'readConfig'>;
  findAvailablePort: typeof findAvailablePort;
  gitCloneService: typeof gitCloneService;
  gitOpsService: typeof gitOpsService;
  getLogFilePath: typeof getLogFilePath;
  getQuickAction: typeof getQuickAction;
  getWorkspaceLinearContext: typeof getWorkspaceLinearContext;
  healthService: typeof healthService;
  initializeWorkspaceWorktree: typeof initializeWorkspaceWorktree;
  insightsService: typeof insightsService;
  linearClientService: typeof linearClientService;
  linearStateSyncService: typeof linearStateSyncService;
  listQuickActions: typeof listQuickActions;
  projectManagementService: typeof projectManagementService;
  updateProjectSettings: (
    input: Parameters<typeof updateProjectSettings>[0]
  ) => ReturnType<typeof updateProjectSettings>;
  rateLimiter: typeof rateLimiter;
  runScriptConfigPersistenceService: typeof runScriptConfigPersistenceService;
  runScriptService: RunScriptService;
  runScriptStateMachine: typeof runScriptStateMachine;
  schedulerService: typeof schedulerService;
  serverInstanceService: ServerInstanceService;
  sessionEventBus: typeof sessionEventBus;
  sessionFileLogger: SessionFileLogger;
  sessionLifecycleEventService: typeof sessionLifecycleEventService;
  sessionLifecycleService: typeof sessionLifecycleService;
  sessionProviderResolverService: typeof sessionProviderResolverService;
  sessionPromptTurnCompletionService: typeof sessionPromptTurnCompletionService;
  sessionRepository: typeof sessionRepository;
  terminalService: typeof terminalService;
  userSettingsQueryService: typeof userSettingsService;
  voiceNarrationService: typeof voiceNarrationService;
  workspaceDataService: typeof workspaceDataService;
  workspaceGitStateService: typeof workspaceGitStateService;
  workspaceNotificationService: typeof workspaceNotificationService;
  workspaceRelationshipsService: typeof workspaceRelationshipsService;
  worktreeLifecycleService: typeof worktreeLifecycleService;
  orphanedWorktreeService: typeof orphanedWorktreeService;
  computePendingRequestType: typeof computePendingRequestType;
  triggerAdversarialReview: typeof triggerAdversarialReview;
  archiveWorkspace: typeof archiveWorkspace;
  cleanupWorkspaceRuntimeResources: typeof cleanupWorkspaceRuntimeResources;
  cleanupWorkspaceScopedCaches(workspaceId: string): void;
  createChildWorkspace: (input: Parameters<typeof createChildWorkspace>[0]) => Promise<string>;
  deliverWorkspaceNotification: typeof deliverWorkspaceNotification;
  workspaceCreationService: WorkspaceCreationService;
  createWorkspaceCreationService: (
    dependencies: ConstructorParameters<typeof WorkspaceCreationService>[0]
  ) => Pick<WorkspaceCreationService, 'create'>;
  launchWorkspace: (
    source: Parameters<typeof launchWorkspace>[0]
  ) => ReturnType<typeof launchWorkspace>;
  renameWorkspace: ReturnType<typeof createWorkspaceRename>['rename'];
  fireLifecycleNotification: typeof fireLifecycleNotification;
  persistChildNotification: typeof persistChildNotification;
  persistParentNotification: typeof persistParentNotification;
  retryQueuedDispatchAfterWorkspaceReady: typeof retryQueuedDispatchAfterWorkspaceReady;
};

export type AppServices = ApplicationServices;
export type AppConfig = ReturnType<typeof configService.getSystemConfig>;

export type ApplicationLifecycle = {
  database: typeof prisma;
  interceptors: {
    register: typeof registerInterceptors;
    start: typeof startInterceptors;
    stop: typeof stopInterceptors;
  };
  wireDomainBridges: typeof configureDomainBridges;
  eventCollector: EventCollectorOrchestrator;
  snapshotReconciliation: SnapshotReconciliationService;
  recoverStaleArchivingWorkspaces: typeof recoverStaleArchivingWorkspaces;
};

export type ApplicationDependencies = {
  readonly services: ApplicationServices;
  readonly lifecycle: ApplicationLifecycle;
};

export type Application = {
  readonly services: Readonly<ApplicationServices>;
  readonly lifecycle: Readonly<ApplicationLifecycle>;
  readonly config: AppConfig;
};

const defaultRunScriptService = createRunScriptService({
  registerShutdownHandlers: true,
});

export function createDefaultApplicationDependencies(): ApplicationDependencies {
  let eventCollector: EventCollectorOrchestrator | null = null;
  const workspaceCreationService = new WorkspaceCreationService({
    logger: createLogger('workspace-creation'),
  });
  const workspaceRename = createWorkspaceRename({
    rename: (id, name) => services.workspaceDataService.rename(id, name),
    publishAcceptedName: (id, name, updatedAt) =>
      services.workspaceSnapshotStore.publishAcceptedName(id, name, updatedAt),
  });
  const services: ApplicationServices = {
    acpRuntimeManager,
    acpTraceLogger,
    autoIterationService,
    chatEventForwarderService,
    sessionCommandFactories,
    sessionLoadService: createSessionLoadService({
      domain: {
        getTranscriptSnapshot: (id) => services.sessionDomainService.getTranscriptSnapshot(id),
        createProviderHistoryFence: (id, providerId) =>
          services.sessionDomainService.createProviderHistoryFence(id, providerId),
        isHistoryHydrated: (id) => services.sessionDomainService.isHistoryHydrated(id),
        getHistoryHydrationSource: (id) =>
          services.sessionDomainService.getHistoryHydrationSource(id),
        markHistoryHydrated: (id, source) =>
          services.sessionDomainService.markHistoryHydrated(id, source),
        clearHistoryRetryCooldown: (id) =>
          services.sessionDomainService.clearHistoryRetryCooldown(id),
        canAttemptHistoryHydration: (id) =>
          services.sessionDomainService.canAttemptHistoryHydration(id),
        setHistoryRetryAt: (id, retryAt) =>
          services.sessionDomainService.setHistoryRetryAt(id, retryAt),
        replaceTranscript: (id, transcript, options) =>
          services.sessionDomainService.replaceTranscript(id, transcript, options),
        consumeInitialMessage: (id) => services.sessionDomainService.consumeInitialMessage(id),
        enqueue: (id, message) => services.sessionDomainService.enqueue(id, message),
        emitDelta: (id, event) => services.sessionDomainService.emitDelta(id, event),
        prepareLoad: (id, runtime) => services.sessionDomainService.prepareLoad(id, runtime),
        finishLoad: (id) => services.sessionDomainService.finishLoad(id),
      },
      config: {
        getSessionConfigProjection: (id) =>
          services.sessionConfigService.getSessionConfigProjection(id),
      },
      hydrateLifecycleEvents: (id) => services.sessionLifecycleEventService.hydrate(id),
      getRuntimeSnapshot: (id) => services.sessionLifecycleService.getRuntimeSnapshot(id),
      tryDispatchNextMessage: (id) => services.sessionDispatchService.tryDispatchNextMessage(id),
    }),
    sessionConfigService,
    sessionPermissionService,
    sessionDispatchService,
    checkGithubAuth,
    cliHealthService,
    configService,
    computePendingRequestType,
    triggerAdversarialReview,
    cryptoService,
    createLogger,
    dataBackupService,
    decisionLogQueryService: decisionLogService,
    metadataSearchService,
    executeStartupScriptPipeline,
    claudeModelCatalogService,
    codexModelCatalogService,
    providerUsageService,
    factoryConfigService: FactoryConfigService,
    findAvailablePort,
    gitCloneService,
    gitOpsService,
    getLogFilePath,
    getQuickAction,
    getWorkspaceLinearContext,
    healthService,
    initializeWorkspaceWorktree: (workspaceId, options) =>
      initializeWorkspaceWorktree(workspaceId, options, {
        sessionDispatch: services.sessionDispatchService,
      }),
    insightsService,
    getWorkspaceInitPolicy,
    githubCLIService,
    logbookService,
    linearClientService,
    linearStateSyncService,
    listQuickActions,
    periodicTaskService,
    projectManagementService,
    updateProjectSettings: (input) =>
      updateProjectSettings(input, {
        validateRepoPath: (repoPath) =>
          services.projectManagementService.validateRepoPath(repoPath),
        findById: (id) => services.projectManagementService.findById(id),
        update: (id, updates) => services.projectManagementService.update(id, updates),
        updateIfStartupUnchanged: (id, expected, updates) =>
          services.projectManagementService.updateIfStartupUnchanged(id, expected, updates),
        encrypt: (apiKey) => services.cryptoService.encrypt(apiKey),
      }),
    prFetchCoordinator,
    prSnapshotService,
    prObservationService,
    ratchetService,
    rateLimiter,
    recoverStaleProvisioningWorkspace,
    runScriptConfigPersistenceService,
    reconciliationService,
    runScriptService: defaultRunScriptService,
    runScriptStateMachine,
    schedulerService,
    serverInstanceService,
    sessionDataService: createSessionDataService({
      providerResolver: {
        resolveSessionDefaults: (input) =>
          services.sessionProviderResolverService.resolveSessionDefaults(input),
      },
    }),
    sessionBackgroundDeliveryService,
    findPRDeliveryReceipt,
    sessionDomainService,
    sessionEventBus,
    sessionFileLogger,
    sessionLifecycleEventService,
    sessionLifecycleService,
    sessionProviderResolverService: createSessionProviderResolverService({
      getDefaultSessionProvider: () =>
        services.userSettingsQueryService.getDefaultSessionProvider(),
      getModelDefaults: () => services.userSettingsQueryService.get(),
      findWorkspace: (id) => services.workspaceDataService.findById(id),
    }),
    sessionPromptTurnCompletionService,
    sessionRepository,
    sessionService,
    startupScriptService,
    terminalService,
    terminalSessionService,
    userSettingsQueryService: userSettingsService,
    userSettingsService,
    voiceNarrationService,
    workspaceActivityService,
    workspaceAutoIterationService,
    workspaceCreationService,
    workspaceDataService,
    renameWorkspace: workspaceRename.rename,
    workspaceMaintenanceService,
    workspaceGitStateService,
    workspaceNotificationService,
    workspacePrSnapshotService,
    workspacePRMonitoringService,
    workspaceQueryService,
    workspaceRelationshipsService,
    workspaceRunScriptService,
    workspaceSnapshotStore,
    workspaceStateMachine,
    worktreeLifecycleService,
    orphanedWorktreeService,
    archiveWorkspace,
    cleanupWorkspaceRuntimeResources,
    cleanupWorkspaceScopedCaches: (workspaceId) => {
      if (!eventCollector) {
        throw new Error('Event collector is not initialized');
      }
      eventCollector.removeWorkspace(workspaceId);
    },
    createChildWorkspace: (input) =>
      createChildWorkspace(input, {
        findProject: (projectId) => services.projectManagementService.findById(projectId),
        launchWorkspace: (source) => services.launchWorkspace(source),
      }),
    deliverWorkspaceNotification: (input) =>
      deliverWorkspaceNotification(input, {
        sessionDispatch: services.sessionDispatchService,
      }),
    createWorkspaceCreationService: (creationDependencies) =>
      new WorkspaceCreationService(creationDependencies),
    launchWorkspace: (source) => {
      const logger = services.createLogger(
        source.type === 'CHILD_WORKSPACE'
          ? 'workspace-children-orchestrator'
          : source.type === 'PERIODIC_TASK'
            ? 'domain-bridges'
            : 'workspace-trpc'
      );
      return launchWorkspace(source, {
        getMaxSessionsPerWorkspace: () => services.configService.getMaxSessionsPerWorkspace(),
        resolveProvider: (...args) =>
          services.sessionProviderResolverService.resolveProviderForWorkspaceCreation(...args),
        checkCliHealth: () => services.cliHealthService.checkHealth(),
        createWorkspace: (input) =>
          source.type === 'PERIODIC_TASK'
            ? services.workspaceCreationService.create(input)
            : services.createWorkspaceCreationService({ logger }).create(input),
        createDefaultSession: (input) => services.sessionDataService.createAgentSession(input),
        initializeWorktree: (workspaceId, options) =>
          services.initializeWorkspaceWorktree(workspaceId, options),
        logger,
      });
    },
    fireLifecycleNotification,
    persistChildNotification,
    persistParentNotification,
    retryQueuedDispatchAfterWorkspaceReady: (workspaceId, startedSessionId) =>
      retryQueuedDispatchAfterWorkspaceReady(workspaceId, startedSessionId, {
        sessionDispatch: services.sessionDispatchService,
      }),
  };

  eventCollector = createEventCollectorOrchestrator(services);

  return {
    services,
    lifecycle: {
      database: prisma,
      interceptors: {
        register: registerInterceptors,
        start: startInterceptors,
        stop: stopInterceptors,
      },
      wireDomainBridges: configureDomainBridges,
      eventCollector,
      snapshotReconciliation: new SnapshotReconciliationService({
        createLogger: services.createLogger,
        gitOpsService: services.gitOpsService,
        session: {
          getRuntimeSnapshot: (id) => services.sessionLifecycleService.getRuntimeSnapshot(id),
          getAllPendingRequests: () => services.chatEventForwarderService.getAllPendingRequests(),
        },
        workspaceMaintenanceService: services.workspaceMaintenanceService,
        workspaceSnapshotStore: services.workspaceSnapshotStore,
      }),
      recoverStaleArchivingWorkspaces,
    },
  };
}

export function createApplication(
  dependencies: ApplicationDependencies = createDefaultApplicationDependencies()
): Application {
  const { services, lifecycle } = dependencies;
  services.acpRuntimeManager.setAcpStartupTimeoutMs?.(
    services.configService.getAcpStartupTimeoutMs()
  );
  services.acpRuntimeManager.configureEnvironment?.({
    childProcessEnvProvider: () => services.configService.getChildProcessEnv(),
  });
  lifecycle.wireDomainBridges(services);
  lifecycle.eventCollector.start();

  return Object.freeze({
    services: Object.freeze(services),
    lifecycle: Object.freeze(lifecycle),
    config: services.configService.getSystemConfig(),
  });
}

export async function disposeApplication(application: Application): Promise<void> {
  application.lifecycle.eventCollector.stop();
  await application.lifecycle.snapshotReconciliation.stop();
  application.services.workspaceGitStateService.stop();
}

export type AppContext = Application;
export const createAppContext = createApplication;

export type { AcpTraceLogger, SessionFileLogger };
