import type { ChatMessageHandler } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { sessionService } from '@/backend/domains/session/lifecycle/session.service';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { UserInputMessage } from '@/shared/websocket';

const logger = createLogger('chat-message-handlers');

export function createUserInputHandler(): ChatMessageHandler<UserInputMessage> {
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

    if (sessionService.isSessionRunning(sessionId)) {
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
