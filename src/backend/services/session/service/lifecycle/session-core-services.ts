import { createLogger } from '@/backend/services/logger.service';
import { sessionLifecycleEventAccessor } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { workspaceDataService, workspaceNotificationService } from '@/backend/services/workspace';
import { AcpEventProcessor } from './acp-event-processor';
import { closedSessionPersistenceService } from './closed-session-persistence.service';
import { SessionConfigService } from './session.config.service';
import { SessionLifecycleService } from './session.lifecycle.service';
import { SessionPermissionService } from './session.permission.service';
import { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import { sessionRepository } from './session.repository';
import { SessionRetryService } from './session.retry.service';
import { SessionService } from './session.service';
import { SessionLifecycleEventService } from './session-lifecycle-event.service';
import { sessionAcpEnvironment, sessionContextService } from './session-lifecycle-external-ports';
import { SessionLifecycleGate } from './session-lifecycle-gate';
import { SessionNotificationDeliveryService } from './session-notification-delivery.service';
import { hydrateProviderHistoryIfNeeded } from './session-provider-history-hydrator';
import { SessionRuntimeExitCoordinator } from './session-runtime-exit.coordinator';
import { SessionStartupCoordinator } from './session-startup.coordinator';
import { SessionTerminationCoordinator } from './session-termination.coordinator';
import { SessionWorkflowFinalizer } from './session-workflow-finalizer';

const logger = createLogger('session');

function cancelTimedOutToolPrompt(sessionId: string, toolUseId: string, toolName: string): void {
  if (!acpRuntimeManager.isSessionRunning(sessionId)) {
    return;
  }
  if (!acpRuntimeManager.isSessionWorking(sessionId)) {
    return;
  }

  logger.warn('Tool call exceeded timeout; requesting ACP prompt cancel', {
    sessionId,
    toolUseId,
    toolName,
  });

  // Soft recovery only: avoid hard-stopping the ACP process so the session
  // can continue/resume without a forced restart.
  acpRuntimeManager.cancelPrompt(sessionId).catch((error: unknown) => {
    logger.warn('Failed to cancel prompt after tool call timeout', {
      sessionId,
      toolUseId,
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export const sessionPermissionService = new SessionPermissionService({
  sessionDomainService,
});

export const sessionConfigService = new SessionConfigService({
  repository: sessionRepository,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
});

export const sessionPromptTurnCompletionService = new SessionPromptTurnCompletionService();
export const sessionRetryService = new SessionRetryService();
export const sessionLifecycleEventService = new SessionLifecycleEventService({
  store: sessionLifecycleEventAccessor,
  sessionDomainService,
});

export const acpEventProcessor = new AcpEventProcessor({
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionPermissionService,
  sessionConfigService,
  onToolCallTimeout: cancelTimedOutToolPrompt,
});

export type SessionPromptService = Pick<
  SessionService,
  'configure' | 'sendAcpMessage' | 'sendSessionMessage'
>;

export const sessionLifecycleGate = new SessionLifecycleGate({
  isRuntimeStopInProgress: (sessionId) => acpRuntimeManager.isStopInProgress(sessionId),
});

export const sessionNotificationDeliveryService = new SessionNotificationDeliveryService({
  notificationPort: workspaceNotificationService,
  queuePort: sessionDomainService,
  transcriptPort: sessionDomainService,
  deltaPort: sessionDomainService,
});

const sessionWorkflowFinalizer = new SessionWorkflowFinalizer({
  repository: sessionRepository,
  workspaceLookup: workspaceDataService,
  sessionDomainService,
  closedSessionPersistenceService,
  lifecycleEventService: sessionLifecycleEventService,
  hydrateProviderHistory: hydrateProviderHistoryIfNeeded,
  runtimeManager: acpRuntimeManager,
  countViewers: (sessionId) => sessionEventBus.countViewers(sessionId),
});

const sessionPromptCoordinator = new SessionService({
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
});

export const sessionService: SessionPromptService = sessionPromptCoordinator;

const sessionRuntimeExitCoordinator = new SessionRuntimeExitCoordinator({
  repository: sessionRepository,
  sessionDomainService,
  sessionPermissionService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
  workflowFinalizer: sessionWorkflowFinalizer,
  onSessionExit: (sessionId) => {
    sessionPromptCoordinator.clearQueuedAcpPrompts(sessionId);
  },
});

let sessionLifecycleServiceInstance: SessionLifecycleService;

const sessionTerminationCoordinator = new SessionTerminationCoordinator({
  repository: sessionRepository,
  retryService: sessionRetryService,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionPermissionService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
  workflowFinalizer: sessionWorkflowFinalizer,
  getRuntimeSnapshot: (sessionId) => sessionLifecycleServiceInstance.getRuntimeSnapshot(sessionId),
  onBeforeStopSession: (sessionId) => {
    sessionPromptCoordinator.clearQueuedAcpPrompts(sessionId);
  },
});

const sessionStartupCoordinator = new SessionStartupCoordinator({
  repository: sessionRepository,
  contextService: sessionContextService,
  acpEnvironment: sessionAcpEnvironment,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionConfigService,
  acpEventProcessor,
  runtimeExitCoordinator: sessionRuntimeExitCoordinator,
  lifecycleGate: sessionLifecycleGate,
  notificationDelivery: sessionNotificationDeliveryService,
  sendSessionMessage: (sessionId, content): Promise<void> =>
    sessionService.sendSessionMessage(sessionId, content),
  stopSession: (sessionId, options) =>
    sessionLifecycleServiceInstance.stopSession(sessionId, options),
});

sessionLifecycleServiceInstance = new SessionLifecycleService({
  startupCoordinator: sessionStartupCoordinator,
  terminationCoordinator: sessionTerminationCoordinator,
  workflowFinalizer: sessionWorkflowFinalizer,
  contextService: sessionContextService,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  lifecycleGate: sessionLifecycleGate,
});

export { sessionLifecycleServiceInstance as sessionLifecycleService };
