import { prisma } from './db';
import { registerInterceptors, startInterceptors, stopInterceptors } from './interceptors';
import { cliHealthService } from './orchestration/cli-health.service';
import { dataBackupService } from './orchestration/data-backup.service';
import { decisionLogQueryService } from './orchestration/decision-log-query.service';
import {
  type BridgeServices,
  configureDomainBridges,
} from './orchestration/domain-bridges.orchestrator';
import {
  createEventCollectorOrchestrator,
  type EventCollectorOrchestrator,
} from './orchestration/event-collector.orchestrator';
import { healthService } from './orchestration/health.service';
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
import {
  initializeWorkspaceWorktree,
  retryQueuedDispatchAfterWorkspaceReady,
} from './orchestration/workspace-init.orchestrator';
import { executeStartupScriptPipeline } from './orchestration/workspace-init-script-pipeline';
import { getQuickAction, listQuickActions } from './prompts/quick-actions';
import { autoIterationService, insightsService, logbookService } from './services/auto-iteration';
import { configService } from './services/config.service';
import { cryptoService } from './services/crypto.service';
import { FactoryConfigService } from './services/factory-config.service';
import { gitCloneService } from './services/git-clone.service';
import { githubCLIService, prFetchRegistry, prSnapshotService } from './services/github';
import { linearClientService } from './services/linear';
import { createLogger, getLogFilePath } from './services/logger.service';
import { periodicTaskAccessor, periodicTaskService } from './services/periodic-task';
import { findAvailablePort } from './services/port.service';
import { fixerSessionService, ratchetService } from './services/ratchet';
import { rateLimiter } from './services/rate-limiter.service';
import {
  createRunScriptService,
  type RunScriptService,
  runScriptStateMachine,
  startupScriptService,
} from './services/run-script';
import { runScriptConfigPersistenceService } from './services/run-script-config-persistence.service';
import {
  createServerInstanceService,
  type ServerInstanceService,
} from './services/server-instance.service';
import {
  type AcpTraceLogger,
  acpRuntimeManager,
  acpTraceLogger,
  chatEventForwarderService,
  chatMessageHandlerService,
  fetchCodexModelCatalogFromAppServer,
  type SessionFileLogger,
  sessionDataService,
  sessionDomainService,
  sessionEventBus,
  sessionFileLogger,
  sessionProviderResolverService,
  sessionService,
} from './services/session';
import { terminalService } from './services/terminal';
import {
  getWorkspaceInitPolicy,
  kanbanStateService,
  projectManagementService,
  userSettingsQueryService,
  WorkspaceCreationService,
  workspaceAccessor,
  workspaceActivityService,
  workspaceDataService,
  workspaceNotificationAccessor,
  workspaceQueryService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from './services/workspace';
import { workspaceSnapshotStore } from './services/workspace-snapshot-store.service';

export type ApplicationServices = BridgeServices & {
  acpRuntimeManager: typeof acpRuntimeManager;
  acpTraceLogger: AcpTraceLogger;
  cliHealthService: typeof cliHealthService;
  configService: typeof configService;
  cryptoService: typeof cryptoService;
  createLogger: typeof createLogger;
  dataBackupService: typeof dataBackupService;
  decisionLogQueryService: typeof decisionLogQueryService;
  executeStartupScriptPipeline: typeof executeStartupScriptPipeline;
  fetchCodexModelCatalogFromAppServer: typeof fetchCodexModelCatalogFromAppServer;
  factoryConfigService: Pick<typeof FactoryConfigService, 'readConfig'>;
  findAvailablePort: typeof findAvailablePort;
  gitCloneService: typeof gitCloneService;
  getLogFilePath: typeof getLogFilePath;
  getQuickAction: typeof getQuickAction;
  healthService: typeof healthService;
  initializeWorkspaceWorktree: typeof initializeWorkspaceWorktree;
  insightsService: typeof insightsService;
  linearClientService: typeof linearClientService;
  listQuickActions: typeof listQuickActions;
  periodicTaskAccessor: typeof periodicTaskAccessor;
  projectManagementService: typeof projectManagementService;
  rateLimiter: typeof rateLimiter;
  runScriptConfigPersistenceService: typeof runScriptConfigPersistenceService;
  runScriptService: RunScriptService;
  runScriptStateMachine: typeof runScriptStateMachine;
  schedulerService: typeof schedulerService;
  serverInstanceService: ServerInstanceService;
  sessionEventBus: typeof sessionEventBus;
  sessionFileLogger: SessionFileLogger;
  sessionProviderResolverService: typeof sessionProviderResolverService;
  terminalService: typeof terminalService;
  userSettingsQueryService: typeof userSettingsQueryService;
  workspaceDataService: typeof workspaceDataService;
  workspaceNotificationAccessor: typeof workspaceNotificationAccessor;
  worktreeLifecycleService: typeof worktreeLifecycleService;
  archiveWorkspace: typeof archiveWorkspace;
  cleanupWorkspaceRuntimeResources: typeof cleanupWorkspaceRuntimeResources;
  createChildWorkspace: typeof createChildWorkspace;
  createWorkspaceCreationService: (
    dependencies: ConstructorParameters<typeof WorkspaceCreationService>[0]
  ) => Pick<WorkspaceCreationService, 'create'>;
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
  return {
    services: {
      acpRuntimeManager,
      acpTraceLogger,
      autoIterationService,
      chatEventForwarderService,
      chatMessageHandlerService,
      cliHealthService,
      configService,
      cryptoService,
      createLogger,
      dataBackupService,
      decisionLogQueryService,
      executeStartupScriptPipeline,
      fetchCodexModelCatalogFromAppServer,
      factoryConfigService: FactoryConfigService,
      findAvailablePort,
      gitCloneService,
      getLogFilePath,
      getQuickAction,
      healthService,
      initializeWorkspaceWorktree,
      insightsService,
      fixerSessionService,
      getWorkspaceInitPolicy,
      githubCLIService,
      kanbanStateService,
      logbookService,
      linearClientService,
      listQuickActions,
      periodicTaskAccessor,
      periodicTaskService,
      projectManagementService,
      prFetchRegistry,
      prSnapshotService,
      ratchetService,
      rateLimiter,
      runScriptConfigPersistenceService,
      reconciliationService,
      runScriptService: defaultRunScriptService,
      runScriptStateMachine,
      schedulerService,
      serverInstanceService: createServerInstanceService(),
      sessionDataService,
      sessionDomainService,
      sessionEventBus,
      sessionFileLogger,
      sessionProviderResolverService,
      sessionService,
      startupScriptService,
      terminalService,
      userSettingsQueryService,
      workspaceAccessor,
      workspaceActivityService,
      workspaceDataService,
      workspaceNotificationAccessor,
      workspaceQueryService,
      workspaceSnapshotStore,
      workspaceStateMachine,
      worktreeLifecycleService,
      archiveWorkspace,
      cleanupWorkspaceRuntimeResources,
      createChildWorkspace,
      createWorkspaceCreationService: (creationDependencies) =>
        new WorkspaceCreationService(creationDependencies),
      fireLifecycleNotification,
      persistChildNotification,
      persistParentNotification,
      retryQueuedDispatchAfterWorkspaceReady,
    },
    lifecycle: {
      database: prisma,
      interceptors: {
        register: registerInterceptors,
        start: startInterceptors,
        stop: stopInterceptors,
      },
      wireDomainBridges: configureDomainBridges,
      eventCollector: createEventCollectorOrchestrator(),
      snapshotReconciliation: new SnapshotReconciliationService(),
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

export type { AcpTraceLogger, SessionFileLogger };
