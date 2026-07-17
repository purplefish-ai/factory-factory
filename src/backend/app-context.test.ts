import { describe, expect, it, vi } from 'vitest';

const fakeModules = vi.hoisted(() => {
  class FakeSnapshotReconciliationService {
    configure = vi.fn();
    start = vi.fn();
    stop = vi.fn(async () => undefined);
  }

  return {
    database: { $disconnect: vi.fn() },
    interceptors: { register: vi.fn(), start: vi.fn(), stop: vi.fn() },
    cliHealthService: {},
    dataBackupService: {},
    decisionLogQueryService: {},
    wireDomainBridges: vi.fn(),
    createEventCollectorOrchestrator: vi.fn(() => ({
      configure: vi.fn(),
      stop: vi.fn(),
    })),
    healthService: {},
    reconciliationService: {},
    schedulerService: {},
    SnapshotReconciliationService: FakeSnapshotReconciliationService,
    workspaceArchive: {
      archiveWorkspace: vi.fn(),
      cleanupWorkspaceRuntimeResources: vi.fn(),
      recoverStaleArchivingWorkspaces: vi.fn(),
    },
    workspaceChildren: {
      createChildWorkspace: vi.fn(),
      fireLifecycleNotification: vi.fn(),
      persistChildNotification: vi.fn(),
      persistParentNotification: vi.fn(),
    },
    workspaceInit: {
      initializeWorkspaceWorktree: vi.fn(),
      retryQueuedDispatchAfterWorkspaceReady: vi.fn(),
    },
    executeStartupScriptPipeline: vi.fn(),
    quickActions: { getQuickAction: vi.fn(), listQuickActions: vi.fn() },
    autoIteration: { autoIterationService: {}, insightsService: {}, logbookService: {} },
    configService: {
      getSystemConfig: vi.fn(() => ({
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
      })),
    },
    cryptoService: {},
    FactoryConfigService: { readConfig: vi.fn() },
    gitCloneService: {},
    github: { githubCLIService: {}, prFetchRegistry: {}, prSnapshotService: {} },
    linearClientService: {},
    logger: { createLogger: vi.fn(), getLogFilePath: vi.fn() },
    periodic: { periodicTaskAccessor: {}, periodicTaskService: {} },
    findAvailablePort: vi.fn(),
    ratchet: { fixerSessionService: {}, ratchetService: {} },
    rateLimiter: {},
    runScript: {
      createRunScriptService: vi.fn(() => ({})),
      runScriptStateMachine: {},
      startupScriptService: {},
    },
    runScriptConfigPersistenceService: {},
    createServerInstanceService: vi.fn(() => ({})),
    session: {
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
    },
    terminalService: {},
    workspace: {
      getWorkspaceInitPolicy: vi.fn(),
      kanbanStateService: {},
      projectManagementService: {},
      userSettingsQueryService: {},
      WorkspaceCreationService: class {},
      workspaceAccessor: {},
      workspaceActivityService: {},
      workspaceDataService: {},
      workspaceNotificationAccessor: {},
      workspaceQueryService: {},
      workspaceStateMachine: {},
      worktreeLifecycleService: {},
    },
    workspaceSnapshotStore: {},
  };
});

vi.mock('./db', () => ({ prisma: fakeModules.database }));
vi.mock('./interceptors', () => ({
  registerInterceptors: fakeModules.interceptors.register,
  startInterceptors: fakeModules.interceptors.start,
  stopInterceptors: fakeModules.interceptors.stop,
}));
vi.mock('./orchestration/cli-health.service', () => ({
  cliHealthService: fakeModules.cliHealthService,
}));
vi.mock('./orchestration/data-backup.service', () => ({
  dataBackupService: fakeModules.dataBackupService,
}));
vi.mock('./orchestration/decision-log-query.service', () => ({
  decisionLogQueryService: fakeModules.decisionLogQueryService,
}));
vi.mock('./orchestration/domain-bridges.orchestrator', () => ({
  configureDomainBridges: fakeModules.wireDomainBridges,
}));
vi.mock('./orchestration/event-collector.orchestrator', () => ({
  createEventCollectorOrchestrator: fakeModules.createEventCollectorOrchestrator,
}));
vi.mock('./orchestration/health.service', () => ({ healthService: fakeModules.healthService }));
vi.mock('./orchestration/reconciliation.service', () => ({
  reconciliationService: fakeModules.reconciliationService,
}));
vi.mock('./orchestration/scheduler.service', () => ({
  schedulerService: fakeModules.schedulerService,
}));
vi.mock('./orchestration/snapshot-reconciliation.orchestrator', () => ({
  SnapshotReconciliationService: fakeModules.SnapshotReconciliationService,
}));
vi.mock('./orchestration/workspace-archive.orchestrator', () => fakeModules.workspaceArchive);
vi.mock('./orchestration/workspace-children.orchestrator', () => fakeModules.workspaceChildren);
vi.mock('./orchestration/workspace-init.orchestrator', () => fakeModules.workspaceInit);
vi.mock('./orchestration/workspace-init-script-pipeline', () => ({
  executeStartupScriptPipeline: fakeModules.executeStartupScriptPipeline,
}));
vi.mock('./prompts/quick-actions', () => fakeModules.quickActions);
vi.mock('./services/auto-iteration', () => fakeModules.autoIteration);
vi.mock('./services/config.service', () => ({ configService: fakeModules.configService }));
vi.mock('./services/crypto.service', () => ({ cryptoService: fakeModules.cryptoService }));
vi.mock('./services/factory-config.service', () => ({
  FactoryConfigService: fakeModules.FactoryConfigService,
}));
vi.mock('./services/git-clone.service', () => ({ gitCloneService: fakeModules.gitCloneService }));
vi.mock('./services/github', () => fakeModules.github);
vi.mock('./services/linear', () => ({ linearClientService: fakeModules.linearClientService }));
vi.mock('./services/logger.service', () => fakeModules.logger);
vi.mock('./services/periodic-task', () => fakeModules.periodic);
vi.mock('./services/port.service', () => ({ findAvailablePort: fakeModules.findAvailablePort }));
vi.mock('./services/ratchet', () => fakeModules.ratchet);
vi.mock('./services/rate-limiter.service', () => ({ rateLimiter: fakeModules.rateLimiter }));
vi.mock('./services/run-script', () => fakeModules.runScript);
vi.mock('./services/run-script-config-persistence.service', () => ({
  runScriptConfigPersistenceService: fakeModules.runScriptConfigPersistenceService,
}));
vi.mock('./services/server-instance.service', () => ({
  createServerInstanceService: fakeModules.createServerInstanceService,
}));
vi.mock('./services/session', () => fakeModules.session);
vi.mock('./services/terminal', () => ({ terminalService: fakeModules.terminalService }));
vi.mock('./services/workspace', () => fakeModules.workspace);
vi.mock('./services/workspace-snapshot-store.service', () => ({
  workspaceSnapshotStore: fakeModules.workspaceSnapshotStore,
}));

import {
  type ApplicationDependencies,
  type ApplicationLifecycle,
  type ApplicationServices,
  createApplication,
} from './app-context';
import { prisma } from './db';
import { registerInterceptors, startInterceptors, stopInterceptors } from './interceptors';
import { cliHealthService } from './orchestration/cli-health.service';
import { dataBackupService } from './orchestration/data-backup.service';
import { decisionLogQueryService } from './orchestration/decision-log-query.service';
import type { configureDomainBridges } from './orchestration/domain-bridges.orchestrator';
import { createEventCollectorOrchestrator } from './orchestration/event-collector.orchestrator';
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
  runScriptStateMachine,
  startupScriptService,
} from './services/run-script';
import { runScriptConfigPersistenceService } from './services/run-script-config-persistence.service';
import { createServerInstanceService } from './services/server-instance.service';
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
} from './services/session';
import { terminalService } from './services/terminal';
import {
  getWorkspaceInitPolicy,
  kanbanStateService,
  projectManagementService,
  userSettingsQueryService,
  workspaceAccessor,
  workspaceActivityService,
  workspaceDataService,
  workspaceNotificationAccessor,
  workspaceQueryService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from './services/workspace';
import { workspaceSnapshotStore } from './services/workspace-snapshot-store.service';

function createApplicationDependencies(label: string): ApplicationDependencies {
  const setAcpStartupTimeoutMs = vi.fn();
  const configureEnvironment = vi.fn();
  const getChildProcessEnv = vi.fn(() => ({ APPLICATION_LABEL: label }));
  const getRuntimeSnapshot = vi.fn();
  const getAllPendingRequests = vi.fn(() => new Map());
  const graphAcpRuntimeManager = Object.assign({}, acpRuntimeManager, {
    setAcpStartupTimeoutMs,
    configureEnvironment,
  }) satisfies typeof acpRuntimeManager;
  const graphConfigService = Object.assign({}, configService, {
    getAcpStartupTimeoutMs: vi.fn(() => 4321),
    isProduction: vi.fn(() => false),
    getChildProcessEnv,
    getSystemConfig: vi.fn(() => configService.getSystemConfig()),
  }) satisfies typeof configService;
  const graphSessionService = Object.assign({}, sessionService, {
    getRuntimeSnapshot,
  }) satisfies typeof sessionService;
  const graphChatEventForwarderService = Object.assign({}, chatEventForwarderService, {
    getAllPendingRequests,
  }) satisfies typeof chatEventForwarderService;

  const services = {
    acpRuntimeManager: graphAcpRuntimeManager,
    acpTraceLogger,
    autoIterationService,
    archiveWorkspace,
    chatEventForwarderService: graphChatEventForwarderService,
    chatMessageHandlerService,
    cleanupWorkspaceRuntimeResources,
    cliHealthService,
    configService: graphConfigService,
    createChildWorkspace,
    createLogger,
    createWorkspaceCreationService: () => ({ create: vi.fn() }),
    cryptoService,
    dataBackupService,
    decisionLogQueryService,
    executeStartupScriptPipeline,
    factoryConfigService: FactoryConfigService,
    fetchCodexModelCatalogFromAppServer,
    findAvailablePort,
    fireLifecycleNotification,
    fixerSessionService,
    getLogFilePath,
    getQuickAction,
    getWorkspaceInitPolicy,
    gitCloneService,
    githubCLIService,
    healthService,
    initializeWorkspaceWorktree,
    insightsService,
    kanbanStateService,
    linearClientService,
    listQuickActions,
    logbookService,
    periodicTaskAccessor,
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
    userSettingsQueryService,
    workspaceAccessor,
    workspaceActivityService,
    workspaceDataService,
    workspaceNotificationAccessor,
    workspaceQueryService,
    workspaceSnapshotStore,
    workspaceStateMachine,
    worktreeLifecycleService,
  } satisfies ApplicationServices;

  const lifecycle = {
    database: prisma,
    interceptors: {
      register: registerInterceptors,
      start: startInterceptors,
      stop: stopInterceptors,
    },
    wireDomainBridges: vi.fn<typeof configureDomainBridges>(),
    eventCollector: createEventCollectorOrchestrator(),
    snapshotReconciliation: new SnapshotReconciliationService(),
    recoverStaleArchivingWorkspaces,
  } satisfies ApplicationLifecycle;

  return { services, lifecycle };
}

describe('createApplication', () => {
  it('keeps two complete fake graphs isolated', () => {
    const firstDependencies = createApplicationDependencies('first');
    const secondDependencies = createApplicationDependencies('second');

    const first = createApplication(firstDependencies);
    const second = createApplication(secondDependencies);

    expect(first.lifecycle.wireDomainBridges).toHaveBeenCalledWith(first.services);
    expect(second.lifecycle.wireDomainBridges).toHaveBeenCalledWith(second.services);
    expect(vi.mocked(first.lifecycle.wireDomainBridges).mock.calls[0]?.[0]).toBe(
      firstDependencies.services
    );
    expect(vi.mocked(second.lifecycle.wireDomainBridges).mock.calls[0]?.[0]).toBe(
      secondDependencies.services
    );
    expect(first.lifecycle.eventCollector.configure).toHaveBeenCalledWith(first.services);
    expect(second.lifecycle.eventCollector.configure).toHaveBeenCalledWith(second.services);

    const firstSnapshotBridges = vi.mocked(first.lifecycle.snapshotReconciliation.configure).mock
      .calls[0]?.[0];
    const secondSnapshotBridges = vi.mocked(second.lifecycle.snapshotReconciliation.configure).mock
      .calls[0]?.[0];
    firstSnapshotBridges?.session.getRuntimeSnapshot('first-session');
    firstSnapshotBridges?.session.getAllPendingRequests();
    expect(first.services.sessionService.getRuntimeSnapshot).toHaveBeenCalledWith('first-session');
    expect(first.services.chatEventForwarderService.getAllPendingRequests).toHaveBeenCalledTimes(1);
    expect(second.services.sessionService.getRuntimeSnapshot).not.toHaveBeenCalled();
    expect(second.services.chatEventForwarderService.getAllPendingRequests).not.toHaveBeenCalled();

    secondSnapshotBridges?.session.getRuntimeSnapshot('second-session');
    secondSnapshotBridges?.session.getAllPendingRequests();
    expect(second.services.sessionService.getRuntimeSnapshot).toHaveBeenCalledWith(
      'second-session'
    );
    expect(second.services.chatEventForwarderService.getAllPendingRequests).toHaveBeenCalledTimes(
      1
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.services)).toBe(true);
    expect(Object.isFrozen(first.lifecycle)).toBe(true);
  });

  it('configures ACP from the supplied fake config service', () => {
    const dependencies = createApplicationDependencies('supplied');

    createApplication(dependencies);

    expect(dependencies.services.acpRuntimeManager.setAcpStartupTimeoutMs).toHaveBeenCalledWith(
      4321
    );
    expect(dependencies.services.acpRuntimeManager.configureEnvironment).toHaveBeenCalledWith({
      preferSourceEntrypoint: true,
      childProcessEnvProvider: expect.any(Function),
    });

    const environment = vi.mocked(dependencies.services.acpRuntimeManager.configureEnvironment).mock
      .calls[0]?.[0];
    expect(environment?.childProcessEnvProvider()).toEqual({ APPLICATION_LABEL: 'supplied' });
    expect(dependencies.services.configService.getChildProcessEnv).toHaveBeenCalledTimes(1);
  });
});
