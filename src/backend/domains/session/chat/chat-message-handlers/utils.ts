import type { QueuedMessage } from '@/shared/claude';
import type { QueueMessageInput, StartMessageInput } from '@/shared/websocket';
import { isValidModel } from './constants';

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
