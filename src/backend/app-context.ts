import { prisma } from './db';
import { registerInterceptors, startInterceptors, stopInterceptors } from './interceptors';
import { cliHealthService } from './orchestration/cli-health.service';
import {
  type BridgeServices,
  configureDomainBridges,
} from './orchestration/domain-bridges.orchestrator';
import {
  createEventCollectorOrchestrator,
  type EventCollectorOrchestrator,
} from './orchestration/event-collector.orchestrator';
import { reconciliationService } from './orchestration/reconciliation.service';
import { schedulerService } from './orchestration/scheduler.service';
import { SnapshotReconciliationService } from './orchestration/snapshot-reconciliation.orchestrator';
import { recoverStaleArchivingWorkspaces } from './orchestration/workspace-archive.orchestrator';
import { autoIterationService, logbookService } from './services/auto-iteration';
import { configService } from './services/config.service';
import { githubCLIService, prFetchRegistry, prSnapshotService } from './services/github';
import { createLogger } from './services/logger.service';
import { periodicTaskService } from './services/periodic-task';
import { findAvailablePort } from './services/port.service';
import { fixerSessionService, ratchetService } from './services/ratchet';
import { rateLimiter } from './services/rate-limiter.service';
import {
  createRunScriptService,
  type RunScriptService,
  runScriptStateMachine,
  startupScriptService,
} from './services/run-script';
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
  type SessionFileLogger,
  sessionDataService,
  sessionDomainService,
  sessionFileLogger,
  sessionService,
} from './services/session';
import { terminalService } from './services/terminal';
import {
  getWorkspaceInitPolicy,
  kanbanStateService,
  workspaceAccessor,
  workspaceActivityService,
  workspaceQueryService,
  workspaceStateMachine,
} from './services/workspace';
import { workspaceSnapshotStore } from './services/workspace-snapshot-store.service';

export type ApplicationServices = BridgeServices & {
  acpRuntimeManager: typeof acpRuntimeManager;
  acpTraceLogger: AcpTraceLogger;
  cliHealthService: typeof cliHealthService;
  configService: typeof configService;
  createLogger: typeof createLogger;
  findAvailablePort: typeof findAvailablePort;
  rateLimiter: typeof rateLimiter;
  runScriptService: RunScriptService;
  runScriptStateMachine: typeof runScriptStateMachine;
  schedulerService: typeof schedulerService;
  serverInstanceService: ServerInstanceService;
  sessionFileLogger: SessionFileLogger;
  terminalService: typeof terminalService;
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
      createLogger,
      findAvailablePort,
      fixerSessionService,
      getWorkspaceInitPolicy,
      githubCLIService,
      kanbanStateService,
      logbookService,
      periodicTaskService,
      prFetchRegistry,
      prSnapshotService,
      ratchetService,
      rateLimiter,
      reconciliationService,
      runScriptService: defaultRunScriptService,
      runScriptStateMachine,
      schedulerService,
      serverInstanceService: createServerInstanceService(),
      sessionDataService,
      sessionDomainService,
      sessionFileLogger,
      sessionService,
      startupScriptService,
      terminalService,
      workspaceAccessor,
      workspaceActivityService,
      workspaceQueryService,
      workspaceSnapshotStore,
      workspaceStateMachine,
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
