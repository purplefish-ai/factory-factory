import type { ChatMessageInput } from '@/shared/websocket';
import { createGetHistoryHandler } from './handlers/get-history.handler';
import { createGetQueueHandler } from './handlers/get-queue.handler';
import { createListSessionsHandler } from './handlers/list-sessions.handler';
import { createLoadSessionHandler } from './handlers/load-session.handler';
import { createPermissionResponseHandler } from './handlers/permission-response.handler';
import { createQuestionResponseHandler } from './handlers/question-response.handler';
import { createQueueMessageHandler } from './handlers/queue-message.handler';
import { createRemoveQueuedMessageHandler } from './handlers/remove-queued-message.handler';
import { createRewindFilesHandler } from './handlers/rewind-files.handler';
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
    list_sessions: createListSessionsHandler(),
    start: createStartHandler(deps),
    user_input: createUserInputHandler(),
    queue_message: createQueueMessageHandler(deps),
    remove_queued_message: createRemoveQueuedMessageHandler(),
    stop: createStopHandler(),
    get_history: createGetHistoryHandler(),
    load_session: createLoadSessionHandler(),
    get_queue: createGetQueueHandler(),
    question_response: createQuestionResponseHandler(),
    permission_response: createPermissionResponseHandler(),
    set_model: createSetModelHandler(),
    set_thinking_budget: createSetThinkingBudgetHandler(),
    rewind_files: createRewindFilesHandler(),
  };
}
