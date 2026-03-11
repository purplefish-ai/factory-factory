import type { QueuedMessage } from '@/shared/acp-protocol';
import type { QueueMessageInput, StartMessageInput } from '@/shared/websocket';
import { normalizeOptionalString } from './constants';

export function getValidModel(message: StartMessageInput): string | undefined {
  const selectedModel = normalizeOptionalString(message.selectedModel);
  if (selectedModel) {
    return selectedModel;
  }
  return normalizeOptionalString(message.model);
}

export function getValidReasoningEffort(message: StartMessageInput): string | undefined {
  return normalizeOptionalString(message.reasoningEffort);
}

export function buildQueuedMessage(
  id: string,
  message: QueueMessageInput,
  text: string
): QueuedMessage {
  const selectedModel = normalizeOptionalString(message.settings?.selectedModel) ?? null;
  const reasoningEffort = normalizeOptionalString(message.settings?.reasoningEffort) ?? null;

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
