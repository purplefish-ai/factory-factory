import { chatConnectionService } from './services/chat-connection.service';
import { chatEventForwarderService } from './services/chat-event-forwarder.service';
import { chatMessageHandlerService } from './services/chat-message-handlers.service';
import { ciMonitorService } from './services/ci-monitor.service';
import { cliHealthService } from './services/cli-health.service';
import { configService } from './services/config.service';
import { githubCLIService } from './services/github-cli.service';
import { kanbanStateService } from './services/kanban-state.service';
import { createLogger } from './services/logger.service';
import { messageQueueService } from './services/message-queue.service';
import { messageStateService } from './services/message-state.service';
import { findAvailablePort } from './services/port.service';
import { prReviewMonitorService } from './services/pr-review-monitor.service';
import { rateLimiter } from './services/rate-limiter.service';
import { RunScriptService } from './services/run-script.service';
import { schedulerService } from './services/scheduler.service';
import { serverInstanceService } from './services/server-instance.service';
import { sessionService } from './services/session.service';
import { type SessionFileLogger, sessionFileLogger } from './services/session-file-logger.service';
import { startupScriptService } from './services/startup-script.service';
import { terminalService } from './services/terminal.service';
import { workspaceStateMachine } from './services/workspace-state-machine.service';

export type AppServices = {
  chatConnectionService: typeof chatConnectionService;
  chatEventForwarderService: typeof chatEventForwarderService;
  chatMessageHandlerService: typeof chatMessageHandlerService;
  ciMonitorService: typeof ciMonitorService;
  cliHealthService: typeof cliHealthService;
  configService: typeof configService;
  createLogger: typeof createLogger;
  findAvailablePort: typeof findAvailablePort;
  githubCLIService: typeof githubCLIService;
  kanbanStateService: typeof kanbanStateService;
  messageQueueService: typeof messageQueueService;
  messageStateService: typeof messageStateService;
  prReviewMonitorService: typeof prReviewMonitorService;
  rateLimiter: typeof rateLimiter;
  runScriptService: typeof RunScriptService;
  schedulerService: typeof schedulerService;
  serverInstanceService: typeof serverInstanceService;
  sessionFileLogger: SessionFileLogger;
  sessionService: typeof sessionService;
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
    ciMonitorService,
    cliHealthService,
    configService,
    createLogger,
    findAvailablePort,
    githubCLIService,
    kanbanStateService,
    messageQueueService,
    messageStateService,
    prReviewMonitorService,
    rateLimiter,
    runScriptService: RunScriptService,
    schedulerService,
    serverInstanceService,
    sessionFileLogger,
    sessionService,
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
