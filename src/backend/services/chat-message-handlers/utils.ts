import type { QueueMessageInput, StartMessageInput } from '@/shared/websocket';
import { createLogger } from '../logger.service';
import type { QueuedMessage } from '../message-queue.service';
import { messageStateService } from '../message-state.service';
import { DEBUG_CHAT_WS, isValidModel } from './constants';

const logger = createLogger('chat-message-handlers');

export function getValidModel(message: StartMessageInput): string | undefined {
  const requestedModel = message.selectedModel || message.model;
  return isValidModel(requestedModel) ? requestedModel : undefined;
}

export function buildQueuedMessage(
  id: string,
  message: QueueMessageInput,
  text: string
): QueuedMessage {
  const rawModel = message.settings?.selectedModel ?? null;
  const validModel = isValidModel(rawModel) ? rawModel : null;

  return {
    id,
    text,
    attachments: message.attachments,
    settings: message.settings
      ? { ...message.settings, selectedModel: validModel }
      : { selectedModel: validModel, thinkingEnabled: false, planModeEnabled: false },
    timestamp: new Date().toISOString(),
  };
}

export function notifyMessageAccepted(sessionId: string, queuedMsg: QueuedMessage): void {
  messageStateService.createUserMessage(sessionId, queuedMsg);

  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Message queued', { sessionId, messageId: queuedMsg.id });
  }
}
