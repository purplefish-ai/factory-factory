import type { WebSocket } from 'ws';
import { createLogger } from '@/backend/services/logger.service';
import { acpRuntimeManager } from '@/backend/services/session/service/acp';
import type { SessionInitPolicyBridge } from '@/backend/services/session/service/bridges';
import {
  isSessionCommandMessage,
  type SessionCommandOutcome,
} from '@/backend/services/session/service/chat/session-command.types';
import type { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import type {
  DispatchOptions,
  SessionDispatchLifecycleDependencies,
} from '@/backend/services/session/service/dispatch/session-dispatch.types';
import {
  sessionConfigService,
  sessionPermissionService,
  sessionService,
} from '@/backend/services/session/service/lifecycle/session-core-services';
import type { ChatMessageInput } from '@/shared/websocket';
import {
  type ChatMessageHandlerRegistry,
  createChatMessageHandlerRegistry,
} from './chat-message-handlers/registry';

const logger = createLogger('chat-message-handlers');

/** Routes incoming WebSocket messages; dispatch APIs temporarily delegate to the session dispatcher. */
export class ChatMessageHandlerService {
  private handlerRegistry: ChatMessageHandlerRegistry | null = null;

  constructor(private readonly dispatcher: SessionDispatchService) {}

  configure(bridges: { initPolicy: SessionInitPolicyBridge }): void {
    this.dispatcher.configure(bridges);
  }

  configureLifecycle(dependencies: SessionDispatchLifecycleDependencies): void {
    this.dispatcher.configureLifecycle(dependencies);
    this.handlerRegistry = createChatMessageHandlerRegistry({
      acpRuntimeManager,
      sessionConfigService,
      sessionPermissionService,
      sessionService,
      startupService: dependencies.startup,
      tryDispatchNextMessage: this.tryDispatchNextMessage.bind(this),
      setManualDispatchResume: this.setManualDispatchResume.bind(this),
      resetDispatchState: this.resetDispatchState.bind(this),
    });
  }

  setManualDispatchResume(sessionId: string, resumed: boolean): void {
    this.dispatcher.setManualDispatchResume(sessionId, resumed);
  }

  resetDispatchState(sessionId: string): void {
    this.dispatcher.resetDispatchState(sessionId);
  }

  tryDispatchNextMessage(sessionId: string, options?: DispatchOptions): Promise<void> {
    return this.dispatcher.tryDispatchNextMessage(sessionId, options);
  }

  /**
   * Handle incoming chat messages by type.
   */
  async handleMessage(
    ws: WebSocket,
    dbSessionId: string | null,
    workingDir: string,
    message: ChatMessageInput
  ): Promise<SessionCommandOutcome | undefined> {
    const registry = this.lifecycleHandlerRegistry;
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

  private get lifecycleHandlerRegistry(): ChatMessageHandlerRegistry {
    if (!this.handlerRegistry) {
      throw new Error('ChatMessageHandlerService not configured: lifecycle gate/startup missing');
    }
    return this.handlerRegistry;
  }
}
