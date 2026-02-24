// Domain imports (from barrel files)
import { githubCLIService } from './domains/github';
import { ratchetService } from './domains/ratchet';
import {
  createRunScriptService,
  type RunScriptService,
  runScriptStateMachine,
  startupScriptService,
} from './domains/run-script';
import {
  type AcpTraceLogger,
  acpRuntimeManager,
  acpTraceLogger,
  chatConnectionService,
  chatEventForwarderService,
  chatMessageHandlerService,
  createSessionService,
  type SessionFileLogger,
  sessionDomainService,
  sessionFileLogger,
  sessionService,
} from './domains/session';
import { terminalService } from './domains/terminal';
import { kanbanStateService, workspaceStateMachine } from './domains/workspace';
// Orchestration and infrastructure imports
import { cliHealthService } from './orchestration/cli-health.service';
import { schedulerService } from './orchestration/scheduler.service';
import { configService } from './services/config.service';
import { createLogger } from './services/logger.service';
import { findAvailablePort } from './services/port.service';
import { rateLimiter } from './services/rate-limiter.service';
import { serverInstanceService } from './services/server-instance.service';

export type AppServices = {
  acpRuntimeManager: typeof acpRuntimeManager;
  chatConnectionService: typeof chatConnectionService;
  chatEventForwarderService: typeof chatEventForwarderService;
  chatMessageHandlerService: typeof chatMessageHandlerService;
  cliHealthService: typeof cliHealthService;
  configService: typeof configService;
  createLogger: typeof createLogger;
  findAvailablePort: typeof findAvailablePort;
  githubCLIService: typeof githubCLIService;
  kanbanStateService: typeof kanbanStateService;
  ratchetService: typeof ratchetService;
  rateLimiter: typeof rateLimiter;
  runScriptService: RunScriptService;
  runScriptStateMachine: typeof runScriptStateMachine;
  schedulerService: typeof schedulerService;
  serverInstanceService: typeof serverInstanceService;
  acpTraceLogger: AcpTraceLogger;
  sessionFileLogger: SessionFileLogger;
  sessionService: typeof sessionService;
  sessionDomainService: typeof sessionDomainService;
  startupScriptService: typeof startupScriptService;
  terminalService: typeof terminalService;
  workspaceStateMachine: typeof workspaceStateMachine;
};

export type AppConfig = ReturnType<typeof configService.getSystemConfig>;

export type AppContext = {
  services: AppServices;
  config: AppConfig;
};

const defaultRunScriptService = createRunScriptService({
  registerShutdownHandlers: true,
});

export function createServices(overrides: Partial<AppServices> = {}): AppServices {
  const resolvedAcpRuntimeManager = overrides.acpRuntimeManager ?? acpRuntimeManager;
  if (typeof resolvedAcpRuntimeManager.setAcpStartupTimeoutMs === 'function') {
    resolvedAcpRuntimeManager.setAcpStartupTimeoutMs(configService.getAcpStartupTimeoutMs());
  }
  const resolvedSessionDomainService = overrides.sessionDomainService ?? sessionDomainService;
  const resolvedSessionService =
    overrides.sessionService ??
    (resolvedAcpRuntimeManager === acpRuntimeManager &&
    resolvedSessionDomainService === sessionDomainService
      ? sessionService
      : createSessionService({
          runtimeManager: resolvedAcpRuntimeManager,
          sessionDomainService: resolvedSessionDomainService,
        }));

  const services: AppServices = {
    acpRuntimeManager: resolvedAcpRuntimeManager,
    chatConnectionService,
    chatEventForwarderService,
    chatMessageHandlerService,
    cliHealthService,
    configService,
    createLogger,
    findAvailablePort,
    githubCLIService,
    kanbanStateService,
    ratchetService,
    rateLimiter,
    runScriptService: overrides.runScriptService ?? defaultRunScriptService,
    runScriptStateMachine,
    schedulerService,
    serverInstanceService,
    acpTraceLogger,
    sessionFileLogger,
    sessionService: resolvedSessionService,
    sessionDomainService: resolvedSessionDomainService,
    startupScriptService,
    terminalService,
    workspaceStateMachine,
  };

  return {
    ...services,
    ...overrides,
  };
}

export function createAppContext(
  options: { services?: Partial<AppServices>; config?: AppConfig } = {}
): AppContext {
  const services = createServices(options.services);
  const config = options.config ?? services.configService.getSystemConfig();

  return {
    services,
    config,
  };
}

export type { AcpTraceLogger, SessionFileLogger };
