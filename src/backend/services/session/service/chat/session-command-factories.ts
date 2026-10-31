import { projectSessionStartupOptions } from '@/backend/services/session/service/dispatch/session-startup-options';
import { createPermissionResponseHandler } from './chat-message-handlers/handlers/permission-response.handler';
import { createQueueMessageHandler } from './chat-message-handlers/handlers/queue-message.handler';
import { createRemoveQueuedMessageHandler } from './chat-message-handlers/handlers/remove-queued-message.handler';
import { createResumeQueuedMessagesHandler } from './chat-message-handlers/handlers/resume-queued-messages.handler';
import { createSetConfigOptionHandler } from './chat-message-handlers/handlers/set-config-option.handler';
import { createSetModelHandler } from './chat-message-handlers/handlers/set-model.handler';
import { createSetThinkingBudgetHandler } from './chat-message-handlers/handlers/set-thinking-budget.handler';
import { createStartHandler } from './chat-message-handlers/handlers/start.handler';
import { createSteerQueuedMessageHandler } from './chat-message-handlers/handlers/steer-queued-message.handler';
import { createStopHandler } from './chat-message-handlers/handlers/stop.handler';
import { createUserInputHandler } from './chat-message-handlers/handlers/user-input.handler';

/** Stateless command helpers; the transport composes them using its owning application's capabilities. */
export const sessionCommandFactories = {
  projectSessionStartupOptions,
  createPermissionResponseHandler,
  createQueueMessageHandler,
  createRemoveQueuedMessageHandler,
  createResumeQueuedMessagesHandler,
  createSetConfigOptionHandler,
  createSetModelHandler,
  createSetThinkingBudgetHandler,
  createStartHandler,
  createStopHandler,
  createSteerQueuedMessageHandler,
  createUserInputHandler,
};
export type SessionCommandFactories = typeof sessionCommandFactories;
