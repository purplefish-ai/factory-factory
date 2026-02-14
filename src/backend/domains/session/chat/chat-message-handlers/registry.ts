import type { ChatMessageInput } from '@/shared/websocket';
import { createLoadSessionHandler } from './handlers/load-session.handler';
import { createPermissionResponseHandler } from './handlers/permission-response.handler';
import { createQueueMessageHandler } from './handlers/queue-message.handler';
import { createRemoveQueuedMessageHandler } from './handlers/remove-queued-message.handler';
import { createResumeQueuedMessagesHandler } from './handlers/resume-queued-messages.handler';
import { createSetConfigOptionHandler } from './handlers/set-config-option.handler';
import { createSetModelHandler } from './handlers/set-model.handler';
import { createSetThinkingBudgetHandler } from './handlers/set-thinking-budget.handler';
import { createStartHandler } from './handlers/start.handler';
import { createStopHandler } from './handlers/stop.handler';
import { createUserInputHandler } from './handlers/user-input.handler';
import type { ChatMessageHandler, HandlerRegistryDependencies } from './types';

/**
 * Type-safe registry that maps each message type to a handler for that specific message type.
 * This ensures handlers receive correctly typed messages without needing casts.
 */
export type ChatMessageHandlerRegistry = {
  [K in ChatMessageInput['type']]: ChatMessageHandler<Extract<ChatMessageInput, { type: K }>>;
};

export function createChatMessageHandlerRegistry(
  deps: HandlerRegistryDependencies
): ChatMessageHandlerRegistry {
  return {
    start: createStartHandler(deps),
    user_input: createUserInputHandler(),
    queue_message: createQueueMessageHandler(deps),
    remove_queued_message: createRemoveQueuedMessageHandler(),
    resume_queued_messages: createResumeQueuedMessagesHandler(deps),
    stop: createStopHandler(),
    load_session: createLoadSessionHandler(),
    permission_response: createPermissionResponseHandler(),
    set_model: createSetModelHandler(),
    set_thinking_budget: createSetThinkingBudgetHandler(),
    set_config_option: createSetConfigOptionHandler(),
  };
}
