import { MessageState, type QueuedMessage, resolveSelectedModel } from '@/shared/acp-protocol';
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

export function buildAcceptedMessageStateChange(
  id: string,
  queuedMessage: QueuedMessage,
  queuePosition: number
) {
  return {
    type: 'message_state_changed' as const,
    id,
    newState: MessageState.ACCEPTED,
    queuePosition,
    userMessage: {
      text: queuedMessage.text,
      timestamp: queuedMessage.timestamp,
      attachments: queuedMessage.attachments,
      settings: {
        ...queuedMessage.settings,
        selectedModel: resolveSelectedModel(queuedMessage.settings.selectedModel),
        reasoningEffort: queuedMessage.settings.reasoningEffort,
      },
    },
  };
}
