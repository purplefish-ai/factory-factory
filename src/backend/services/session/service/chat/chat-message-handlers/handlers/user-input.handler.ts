import { createLogger } from '@/backend/services/logger.service';
import type {
  SessionCommandPromptService,
  SessionCommandRuntimeManager,
} from '@/backend/services/session/service/chat/session-command.types';
import type {
  SessionCommandHandler,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { UserInputMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createUserInputHandler(deps: {
  acpRuntimeManager: SessionCommandRuntimeManager;
  sessionService: SessionCommandPromptService;
  backgroundDelivery: SessionExecutionCommandServices['backgroundDelivery'];
}): SessionCommandHandler<UserInputMessage> {
  const { acpRuntimeManager, sessionService } = deps;

  return ({ sessionId }, message) => {
    const rawContent = message.content || message.text;
    if (!rawContent) {
      return { replies: [] };
    }

    if (typeof rawContent === 'string' && !rawContent.trim()) {
      return { replies: [] };
    }

    // Cast content array to AgentContentItem[] - validation is done at WebSocket handler level
    const messageContent =
      typeof rawContent === 'string' ? rawContent : (rawContent as AgentContentItem[]);

    if (acpRuntimeManager.isSessionRunning(sessionId)) {
      const isCurrent = deps.backgroundDelivery.captureResumeGuard(sessionId);
      void sessionService.sendSessionMessage(sessionId, messageContent).catch((error) => {
        logger.error('Failed to send message to provider', { sessionId, error });
      });
      void deps.backgroundDelivery.userResume(sessionId, isCurrent).catch((error) => {
        logger.warn('Failed to resume PR delivery after human input', { sessionId, error });
      });
      return { replies: [] };
    }

    return { replies: [{ type: 'error', error: { kind: 'no_active_session' } }] };
  };
}
