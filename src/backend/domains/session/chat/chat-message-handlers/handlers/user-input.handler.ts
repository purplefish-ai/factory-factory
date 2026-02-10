import type { UserInputMessage } from '@/shared/websocket';
import type { ClaudeContentItem } from '../../../claude/types';
import { createLogger } from '@/backend/services/logger.service';
import { sessionService } from '@/backend/services/session.service';
import type { ChatMessageHandler } from '../types';

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

    // Cast content array to ClaudeContentItem[] - validation is done at WebSocket handler level
    const messageContent =
      typeof rawContent === 'string' ? rawContent : (rawContent as ClaudeContentItem[]);

    const existingClient = sessionService.getClient(sessionId);
    if (existingClient?.isRunning()) {
      existingClient.sendMessage(messageContent).catch((error) => {
        logger.error('Failed to send message to Claude', { sessionId, error });
      });
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'No active Claude session. Use queue_message to queue messages.',
      })
    );
  };
}
