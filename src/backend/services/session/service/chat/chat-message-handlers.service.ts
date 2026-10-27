import type { WebSocket } from 'ws';
import { createLogger } from '@/backend/services/logger.service';
import {
  isSessionCommandMessage,
  type SessionCommandOutcome,
} from '@/backend/services/session/service/chat/session-command.types';
import type { ChatMessageInput } from '@/shared/websocket';
import type { ChatMessageHandlerRegistry } from './chat-message-handlers/registry';

const logger = createLogger('chat-message-handlers');

/** Routes incoming WebSocket messages through the composed handler registry. */
export class ChatMessageHandlerService {
  constructor(private readonly handlerRegistry: ChatMessageHandlerRegistry) {}

  /**
   * Handle incoming chat messages by type.
   */
  async handleMessage(
    ws: WebSocket,
    dbSessionId: string | null,
    workingDir: string,
    message: ChatMessageInput
  ): Promise<SessionCommandOutcome | undefined> {
    const registry = this.handlerRegistry;
    if (isSessionCommandMessage(message)) {
      if (!dbSessionId) {
        return { replies: [{ type: 'error', error: { kind: 'no_session' } }] };
      }
      const context = { sessionId: dbSessionId, workingDir };
      switch (message.type) {
        case 'set_model':
          return registry.set_model(context, message);
        case 'set_config_option':
          return registry.set_config_option(context, message);
        case 'set_thinking_budget':
          return registry.set_thinking_budget(context, message);
        case 'permission_response':
          return registry.permission_response(context, message);
      }
    }
    const handler = registry[message.type] as
      | ((context: {
          ws: WebSocket;
          sessionId: string;
          workingDir: string;
          message: ChatMessageInput;
        }) => Promise<void> | void)
      | undefined;

    if (!handler) {
      logger.warn('[Chat WS] No handler registered for message type', { type: message.type });
      return;
    }

    // All other operations require a session
    if (!dbSessionId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'No session selected. Please create or select a session first.',
        })
      );
      return;
    }

    await handler({ ws, sessionId: dbSessionId, workingDir, message });
    return undefined;
  }
}
