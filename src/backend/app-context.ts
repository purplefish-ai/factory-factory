import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentAuthoring } from '@/backend/orchestration/agent-authoring.orchestrator';
import { createAgentRuntime } from '@/backend/orchestration/agent-runtime.orchestrator';
import { createShutdownPlan, runShutdownPlan } from './application-shutdown';
import { prisma } from './db';
import { registerInterceptors, startInterceptors, stopInterceptors } from './interceptors';
import { triggerAdversarialReview } from './orchestration/adversarial-review.orchestrator';
import { createAgentManagement } from './orchestration/agent-management.orchestrator';
import {
  ApplicationUpdateService,
  createProcessUpdateSupervisor,
} from './orchestration/application-update.service';
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
import { searchGitHubIssues } from './orchestration/github-issue-search.orchestrator';
import { getWorkspaceLinearContext } from './orchestration/linear-config.helper';
import { bindIssueMonitoringSession } from './orchestration/pr-monitoring.orchestrator';
import { updateProjectSettings } from './orchestration/project-settings.orchestrator';
import { reconciliationService } from './orchestration/reconciliation.service';
import { listVisibleReviewRequests } from './orchestration/review-requests.orchestrator';
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
import { createWorkspaceFollowUp } from './orchestration/workspace-follow-up.orchestrator';
import { executeStartupScriptPipeline } from './orchestration/workspace-init-script-pipeline';
import {
  initializeWorkspaceWorktree,
  enqueueWorkspaceInitializationTask,
  recoverStaleProvisioningWorkspace,
  retryQueuedDispatchAfterWorkspaceReady,
} from './orchestration/workspace-init.orchestrator';
import { launchWorkspace } from './orchestration/workspace-launch.orchestrator';
import { WorkspaceMetadataOrchestrator } from './orchestration/workspace-metadata.orchestrator';
import {
  deliverWorkspaceNotification,
  recoverWorkspaceMail,
} from './orchestration/workspace-notification-delivery.orchestrator';
import { createWorkspaceRename } from './orchestration/workspace-rename.orchestrator';
import {
  captureWorkspaceRetryGuard,
  readWorkspaceRetryAvailability,
} from './orchestration/workspace-retry-authority';
import { getQuickAction, listQuickActions } from './prompts/quick-actions';
import { agentManagementService, type AgentManagementService } from './services/agent-definition';
import { agentProposalService, slackConnectionService } from './services/agent-definition';
import { applicationReleaseService } from './services/application-update';
import { applicationUpdateAdmission } from './services/application-update-admission.service';
import { codexAccountService } from './services/codex-accounts';
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
import { jobRunner } from './services/job-runner.service';
import { linearClientService, linearStateSyncService } from './services/linear';
import { createLogger, getLogFilePath } from './services/logger.service';
import { periodicTaskService } from './services/periodic-task';
import { type PortShareService, portShareService } from './services/port-share';
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
  generateWorkspaceMetadata,
  sessionInterceptorBridge,
} from './services/session';
import { settingsHealthService, userSettingsService } from './services/settings';
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
  applicationUpdateAdmission: Pick<typeof applicationUpdateAdmission, 'run' | 'assertOpen'>;
  applicationUpdateService: Pick<
    ApplicationUpdateService,
    'start' | 'stop' | 'checkUpdates' | 'requestUpdate' | 'cancelUpdate'
  >;
  agentRuntime: ReturnType<typeof createAgentRuntime>;
  agentAuthoring: ReturnType<typeof createAgentAuthoring>;
  agentManagement: ReturnType<typeof createAgentManagement>;
  agentManagementService: AgentManagementService;
  listVisibleReviewRequests: (repository?: string) => ReturnType<typeof listVisibleReviewRequests>;
  sessionDispatchService: Pick<
    typeof sessionDispatchService,
    | 'configure'
    | 'tryDispatchNextMessage'
    | 'setManualDispatchResume'
    | 'resetDispatchState'
    | 'shutdown'
    | 'steerQueuedMessage'
    | 'steerWorkspaceMailSignal'
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
  codexAccountService: typeof codexAccountService;
  cryptoService: typeof cryptoService;
  slackConnectionService: typeof slackConnectionService;
  agentProposalService: typeof agentProposalService;
  createLogger: typeof createLogger;
  dataBackupService: typeof dataBackupService;
  decisionLogQueryService: typeof decisionLogService;
  metadataSearchService: typeof metadataSearchService;
  searchGitHubIssues: (
    input: Parameters<typeof searchGitHubIssues>[0]
  ) => ReturnType<typeof searchGitHubIssues>;
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
  settingsHealthService: typeof settingsHealthService;
  initializeWorkspaceWorktree: typeof initializeWorkspaceWorktree;
  enqueueWorkspaceInitializationTask: typeof enqueueWorkspaceInitializationTask;
  captureWorkspaceRetryGuard: typeof captureWorkspaceRetryGuard;
  readWorkspaceRetryAvailability: typeof readWorkspaceRetryAvailability;
  linearClientService: typeof linearClientService;
  linearStateSyncService: typeof linearStateSyncService;
  listQuickActions: typeof listQuickActions;
  projectManagementService: typeof projectManagementService;
  updateProjectSettings: (
    input: Parameters<typeof updateProjectSettings>[0]
  ) => ReturnType<typeof updateProjectSettings>;
  portShareService: PortShareService;
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
  recoverWorkspaceMail: (workspaceId: string) => ReturnType<typeof recoverWorkspaceMail>;
  workspaceCreationService: WorkspaceCreationService;
  createWorkspaceCreationService: (
    dependencies: ConstructorParameters<typeof WorkspaceCreationService>[0]
  ) => Pick<WorkspaceCreationService, 'create'>;
  launchWorkspace: (
    source: Parameters<typeof launchWorkspace>[0]
  ) => ReturnType<typeof launchWorkspace>;
  renameWorkspace: ReturnType<typeof createWorkspaceRename>['rename'];
  acceptWorkspaceFollowUp: ReturnType<typeof createWorkspaceFollowUp>;
  fireLifecycleNotification: typeof fireLifecycleNotification;
  persistChildNotification: typeof persistChildNotification;
  persistParentNotification: typeof persistParentNotification;
  retryQueuedDispatchAfterWorkspaceReady: typeof retryQueuedDispatchAfterWorkspaceReady;
};

export type AppServices = ApplicationServices;
export type AppConfig = ReturnType<typeof configService.getSystemConfig>;

export type ApplicationLifecycle = {
  database: typeof prisma;
  jobs: Pick<typeof jobRunner, 'stopAll'>;
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

let processRunScriptService: RunScriptService | null = null;

/**
 * The run-script service registers process signal and exit handlers, so a
 * process has one, shared by every graph it composes. It is created on first
 * composition rather than when this module is imported.
 */
function getProcessRunScriptService(): RunScriptService {
  processRunScriptService ??= createRunScriptService({ registerShutdownHandlers: true });
  return processRunScriptService;
}

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
  const applicationUpdateService = new ApplicationUpdateService({
    release: applicationReleaseService,
    admission: applicationUpdateAdmission,
    jobs: jobRunner,
    supervisor: createProcessUpdateSupervisor(),
    manualCommand: process.versions.electron
      ? 'Download the latest Factory Factory desktop release.'
      : existsSync(join(applicationReleaseService.getPackageRoot(), 'src/cli/index.ts'))
        ? 'Update this checkout with git pull and pnpm install, then restart Factory Factory.'
        : 'npm install -g factory-factory@latest',
    hasWork: () =>
      services.sessionDomainService.hasPendingUpdateWork() ||
      [...services.acpRuntimeManager.getAllClients()].some(([id]) =>
        services.acpRuntimeManager.isSessionWorking(id)
      ) ||
      services.agentRuntime.hasWork(),
  });
  // Workspace startup binds the issue conversation inside this graph's PR
  // monitoring scope, read at call time so tests can replace the dispatcher.
  const workspaceDispatch = () => ({
    sessionDispatch: services.sessionDispatchService,
    bindMonitoringSession: (workspaceId: string, sessionId: string) =>
      bindIssueMonitoringSession(workspaceId, sessionId, services),
  });
  const services: ApplicationServices = {
    applicationUpdateAdmission,
    applicationUpdateService,
    listVisibleReviewRequests: (repository) => listVisibleReviewRequests(services, repository),
    acpRuntimeManager,
    acpTraceLogger,
    chatEventForwarderService,
    sessionCommandFactories,
    sessionLoadService: createSessionLoadService({
      domain: {
        getTranscriptSnapshot: (id) => services.sessionDomainService.getTranscriptSnapshot(id),
        getRuntimeSnapshot: (id) => services.sessionDomainService.getRuntimeSnapshot(id),
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
    codexAccountService,
    computePendingRequestType,
    triggerAdversarialReview,
    cryptoService,
    slackConnectionService,
    agentProposalService,
    agentAuthoring: createAgentAuthoring(() => services),
    agentManagementService,
    agentManagement: createAgentManagement(() => services),
    agentRuntime: createAgentRuntime(() => services),
    createLogger,
    dataBackupService,
    decisionLogQueryService: decisionLogService,
    metadataSearchService,
    searchGitHubIssues: (input) =>
      searchGitHubIssues(input, {
        listProjects: (filters) => services.projectManagementService.list(filters),
        searchIssues: (owner, repo, query, limit) =>
          services.githubCLIService.searchIssues(owner, repo, query, limit),
      }),
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
    settingsHealthService,
    enqueueWorkspaceInitializationTask,
    captureWorkspaceRetryGuard,
    readWorkspaceRetryAvailability,
    initializeWorkspaceWorktree: (workspaceId, options) =>
      initializeWorkspaceWorktree(workspaceId, options, workspaceDispatch()),
    getWorkspaceInitPolicy,
    githubCLIService,
    linearClientService,
    linearStateSyncService,
    listQuickActions,
    periodicTaskService,
    portShareService,
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
    runScriptService: getProcessRunScriptService(),
    runScriptStateMachine,
    schedulerService,
    serverInstanceService,
    sessionDataService: createSessionDataService({
      eventAccounts: {
        getRuntimeContext: (id) => services.codexAccountService.getRuntimeContext(id),
        getEnabledAccountIds: () => services.codexAccountService.getEnabledAccountIds(),
      },
      accounts: {
        withAccountReservation: (input, operation) =>
          services.codexAccountService.withAccountReservation(input, operation),
      },
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
    workspaceCreationService,
    workspaceDataService,
    renameWorkspace: workspaceRename.rename,
    acceptWorkspaceFollowUp: (sessionId, acceptedAt) =>
      createWorkspaceFollowUp(services)(sessionId, acceptedAt),
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
        getSettings: () => services.userSettingsQueryService.get(),
        findProject: (projectId) => services.projectManagementService.findById(projectId),
        launchWorkspace: (source) => services.launchWorkspace(source),
      }),
    recoverWorkspaceMail: (workspaceId) =>
      recoverWorkspaceMail(workspaceId, { sessionDispatch: services.sessionDispatchService }),
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
        getLaunchOptions: (input) => services.sessionConfigService.getLaunchOptions(input),
        validateCodexAccount: async (input) => {
          const settings = await services.userSettingsQueryService.get();
          return services.codexAccountService.getPreviewRuntimeContext({
            ...input,
            model: input.model ?? settings.defaultCodexModel,
          });
        },
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
    retryQueuedDispatchAfterWorkspaceReady: (workspaceId, startedSessionId, _dependencies, guard) =>
      retryQueuedDispatchAfterWorkspaceReady(
        workspaceId,
        startedSessionId,
        workspaceDispatch(),
        ...(guard ? ([guard] as const) : [])
      ),
  };

  if (configService.getWorkspaceMetadataConfig().enabled) {
    services.workspaceMetadata = new WorkspaceMetadataOrchestrator({
      findSession: async (id) => {
        const session = await services.sessionDataService.findAgentSessionById(id);
        return session ? { ...session, codexAccountId: session.codexAccountId ?? null } : null;
      },
      history: (id) => sessionInterceptorBridge.getSessionConversationHistory(id, ''),
      findWorkspace: (id) => services.workspaceDataService.findMetadataContext(id),
      reserve: (id, requestId) => services.workspaceDataService.reserveMetadata(id, requestId),
      accept: (input) => services.workspaceDataService.acceptMetadata(input),
      generate: generateWorkspaceMetadata,
      publish: (workspace, projectId, conversationSummary) => {
        services.workspaceSnapshotStore.publishAcceptedName(
          workspace.id,
          workspace.name,
          workspace.updatedAt.getTime()
        );
        services.workspaceSnapshotStore.upsert(
          workspace.id,
          { projectId, conversationSummary },
          'metadata:generated',
          Date.now()
        );
      },
    });
  }
  eventCollector = createEventCollectorOrchestrator(services);

  return {
    services,
    lifecycle: {
      database: prisma,
      jobs: jobRunner,
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
  services.acpRuntimeManager.configureAdmission?.(services.applicationUpdateAdmission);
  services.acpRuntimeManager.configureEnvironment?.({
    childProcessEnvProvider: () => services.configService.getChildProcessEnv(),
  });
  lifecycle.wireDomainBridges(services);
  lifecycle.eventCollector.start();
  services.applicationUpdateService?.start();

  return Object.freeze({
    services: Object.freeze(services),
    lifecycle: Object.freeze(lifecycle),
    config: services.configService.getSystemConfig(),
  });
}

/**
 * Tear down an application no server took ownership of. Runs the same ordered
 * plan as server shutdown, without the server's transport hooks, and rejects
 * with every failure once all steps have been attempted.
 */
export async function disposeApplication(application: Application): Promise<void> {
  const failures: unknown[] = [];
  const failed: string[] = [];
  await runShutdownPlan(createShutdownPlan(application), ({ kind, name, error }) => {
    failures.push(error);
    failed.push(`${kind} ${name}`);
  });
  if (failures.length) {
    throw new AggregateError(failures, `Application disposal failed: ${failed.join(', ')}`);
  }
}

export type AppContext = Application;

export type { AcpTraceLogger, SessionFileLogger };
