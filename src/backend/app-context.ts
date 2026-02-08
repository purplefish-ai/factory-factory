import { chatConnectionService } from './services/chat-connection.service';
import { chatEventForwarderService } from './services/chat-event-forwarder.service';
import { chatMessageHandlerService } from './services/chat-message-handlers.service';
import { cliHealthService } from './services/cli-health.service';
import { configService } from './services/config.service';
import { githubCLIService } from './services/github-cli.service';
import { kanbanStateService } from './services/kanban-state.service';
import { createLogger } from './services/logger.service';
import { findAvailablePort } from './services/port.service';
import { ratchetService } from './services/ratchet.service';
import { rateLimiter } from './services/rate-limiter.service';
import { RunScriptService } from './services/run-script.service';
import { runScriptStateMachine } from './services/run-script-state-machine.service';
import { schedulerService } from './services/scheduler.service';
import { serverInstanceService } from './services/server-instance.service';
import { sessionService } from './services/session.service';
import { type SessionFileLogger, sessionFileLogger } from './services/session-file-logger.service';
import { sessionRuntimeStoreService } from './services/session-runtime-store.service';
import { sessionStoreService } from './services/session-store.service';
import { startupScriptService } from './services/startup-script.service';
import { terminalService } from './services/terminal.service';
import { workspaceStateMachine } from './services/workspace-state-machine.service';

export type AppServices = {
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
  runScriptService: typeof RunScriptService;
  runScriptStateMachine: typeof runScriptStateMachine;
  schedulerService: typeof schedulerService;
  serverInstanceService: typeof serverInstanceService;
  sessionFileLogger: SessionFileLogger;
  sessionService: typeof sessionService;
  sessionStoreService: typeof sessionStoreService;
  sessionRuntimeStoreService: typeof sessionRuntimeStoreService;
  startupScriptService: typeof startupScriptService;
  terminalService: typeof terminalService;
  workspaceStateMachine: typeof workspaceStateMachine;
};

export type AppConfig = ReturnType<typeof configService.getSystemConfig>;

export type AppContext = {
  services: AppServices;
  config: AppConfig;
};

export function createServices(overrides: Partial<AppServices> = {}): AppServices {
  const services: AppServices = {
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
    runScriptService: RunScriptService,
    runScriptStateMachine,
    schedulerService,
    serverInstanceService,
    sessionFileLogger,
    sessionService,
    sessionStoreService,
    sessionRuntimeStoreService,
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

export type { SessionFileLogger };
