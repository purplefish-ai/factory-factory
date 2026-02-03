/**
 * Chat Transport Adapter Service
 *
 * Bridges domain-level message state events to a WebSocket transport.
 */

import { chatConnectionService } from './chat-connection.service';
import { createLogger } from './logger.service';
import { type MessageStateEvent, messageStateService } from './message-state.service';

const logger = createLogger('chat-transport-adapter');

class ChatTransportAdapterService {
  private isSetup = false;
  private unsubscribe: (() => void) | null = null;
  private listener = (event: MessageStateEvent) => {
    switch (event.type) {
      case 'message_state_changed': {
        chatConnectionService.forwardToSession(event.sessionId, {
          type: 'message_state_changed',
          ...event.data,
        });
        break;
      }
      case 'messages_snapshot': {
        chatConnectionService.forwardToSession(event.sessionId, {
          type: 'messages_snapshot',
          ...event.data,
        });
        break;
      }
      default: {
        logger.warn('Unhandled message state event', {
          eventType: (event as MessageStateEvent).type,
        });
      }
    }
  };

  setup(): void {
    if (this.isSetup && messageStateService.hasEventListener(this.listener)) {
      return;
    }
    this.unsubscribe?.();

    this.unsubscribe = messageStateService.onEvent(this.listener);
    this.isSetup = true;
  }

  teardown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.isSetup = false;
  }
}

export const chatTransportAdapterService = new ChatTransportAdapterService();
