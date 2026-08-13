import { createLogger } from '@/backend/services/logger.service';
import { sessionLifecycleEventAccessor } from '@/backend/services/session/resources/session-lifecycle-event.accessor';
import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { AcpEventProcessor } from './acp-event-processor';
import { SessionConfigService } from './session.config.service';
import { SessionLifecycleService } from './session.lifecycle.service';
import { SessionPermissionService } from './session.permission.service';
import { sessionPromptBuilder } from './session.prompt-builder';
import { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import { sessionRepository } from './session.repository';
import { SessionRetryService } from './session.retry.service';
import { SessionService } from './session.service';
import { SessionLifecycleEventService } from './session-lifecycle-event.service';
import { SessionLifecycleGate } from './session-lifecycle-gate';
import { hydrateProviderHistoryIfNeeded } from './session-provider-history-hydrator';

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

const sessionPromptCoordinator = new SessionService({
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
});

export const sessionService: SessionPromptService = sessionPromptCoordinator;

export const sessionLifecycleService: SessionLifecycleService = new SessionLifecycleService({
  repository: sessionRepository,
  promptBuilder: sessionPromptBuilder,
  runtimeManager: acpRuntimeManager,
  sessionDomainService,
  sessionPermissionService,
  sessionConfigService,
  acpEventProcessor,
  promptTurnCompletionService: sessionPromptTurnCompletionService,
  retryService: sessionRetryService,
  lifecycleEventService: sessionLifecycleEventService,
  lifecycleGate: sessionLifecycleGate,
  hydrateProviderHistory: hydrateProviderHistoryIfNeeded,
  sendSessionMessage: (sessionId, content): Promise<void> =>
    sessionService.sendSessionMessage(sessionId, content),
  onBeforeStopSession: (sessionId) => {
    sessionPromptCoordinator.clearQueuedAcpPrompts(sessionId);
  },
  onSessionExit: (sessionId) => {
    sessionPromptCoordinator.clearQueuedAcpPrompts(sessionId);
  },
});
