import { createLogger } from '@/backend/services/logger.service';
import type {
  ChatMessageHandler,
  ChatMessageHandlerPromptService,
  ChatMessageHandlerRuntimeManager,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { UserInputMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createUserInputHandler(deps: {
  acpRuntimeManager: ChatMessageHandlerRuntimeManager;
  sessionService: ChatMessageHandlerPromptService;
}): ChatMessageHandler<UserInputMessage> {
  const { acpRuntimeManager, sessionService } = deps;

  return ({ ws, sessionId, message }) => {
    const rawContent = message.content || message.text;
    if (!rawContent) {
      return;
    }

    if (typeof rawContent === 'string' && !rawContent.trim()) {
      return;
    }

    // Cast content array to AgentContentItem[] - validation is done at WebSocket handler level
    const messageContent =
      typeof rawContent === 'string' ? rawContent : (rawContent as AgentContentItem[]);

    if (acpRuntimeManager.isSessionRunning(sessionId)) {
      void sessionService.sendSessionMessage(sessionId, messageContent).catch((error) => {
        logger.error('Failed to send message to provider', { sessionId, error });
      });
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'No active session. Use queue_message to queue messages.',
      })
    );
  };
}
