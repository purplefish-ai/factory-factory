/**
 * Chat Transport Adapter Service
 *
 * Bridges domain-level message state events to a WebSocket transport.
 */

import { chatConnectionService } from './chat-connection.service';
import { createLogger } from './logger.service';
import { type MessageStateEvent, messageStateService } from './message-state.service';
import {
  type SessionRuntimeEvent,
  sessionRuntimeStoreService,
} from './session-runtime-store.service';

const logger = createLogger('chat-transport-adapter');

class ChatTransportAdapterService {
  private isSetup = false;
  private unsubscribe: (() => void) | null = null;
  private runtimeUnsubscribe: (() => void) | null = null;
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
  private runtimeListener = (event: SessionRuntimeEvent) => {
    switch (event.type) {
      case 'session_runtime_snapshot': {
        chatConnectionService.forwardToSession(event.sessionId, {
          type: 'session_runtime_snapshot',
          ...event.data,
        });
        break;
      }
      case 'session_runtime_updated': {
        chatConnectionService.forwardToSession(event.sessionId, {
          type: 'session_runtime_updated',
          ...event.data,
        });
        break;
      }
      default: {
        logger.warn('Unhandled session runtime event', {
          eventType: (event as SessionRuntimeEvent).type,
        });
      }
    }
  };

  setup(): void {
    if (
      this.isSetup &&
      messageStateService.hasEventListener(this.listener) &&
      sessionRuntimeStoreService.hasEventListener(this.runtimeListener)
    ) {
      return;
    }
    this.unsubscribe?.();
    this.runtimeUnsubscribe?.();

    this.unsubscribe = messageStateService.onEvent(this.listener);
    this.runtimeUnsubscribe = sessionRuntimeStoreService.onEvent(this.runtimeListener);
    this.isSetup = true;
  }

  teardown(): void {
    this.unsubscribe?.();
    this.runtimeUnsubscribe?.();
    this.unsubscribe = null;
    this.runtimeUnsubscribe = null;
    this.isSetup = false;
  }
}

export const chatTransportAdapterService = new ChatTransportAdapterService();
