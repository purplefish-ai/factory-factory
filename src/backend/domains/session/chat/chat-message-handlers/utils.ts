import type { QueuedMessage } from '@/shared/claude';
import type { QueueMessageInput, StartMessageInput } from '@/shared/websocket';
import { normalizeRequestedModel } from './constants';

export function getValidModel(message: StartMessageInput): string | undefined {
  const requestedModel = message.selectedModel || message.model;
  return normalizeRequestedModel(requestedModel);
}

export function getValidReasoningEffort(message: StartMessageInput): string | undefined {
  return normalizeRequestedModel(message.reasoningEffort);
}

export function buildQueuedMessage(
  id: string,
  message: QueueMessageInput,
  text: string
): QueuedMessage {
  const selectedModel = normalizeRequestedModel(message.settings?.selectedModel) ?? null;
  const reasoningEffort = normalizeRequestedModel(message.settings?.reasoningEffort) ?? null;

  return {
    id,
    text,
    attachments: message.attachments,
    settings: message.settings
      ? { ...message.settings, selectedModel, reasoningEffort }
      : { selectedModel, reasoningEffort, thinkingEnabled: false, planModeEnabled: false },
    timestamp: new Date().toISOString(),
  };
}
