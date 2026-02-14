import {
  type ChatMessage,
  DEFAULT_CHAT_SETTINGS,
  MessageState,
  QUEUED_MESSAGE_ORDER_BASE,
  type WebSocketMessage as ReplayEventMessage,
  resolveSelectedModel,
} from '@/shared/acp-protocol';
import type { SessionStore } from './session-store.types';
import { messageSort } from './session-transcript';

export function buildSnapshotMessages(store: SessionStore): ChatMessage[] {
  const snapshot = [...store.transcript];
  store.queue.forEach((queued, index) => {
    snapshot.push({
      id: queued.id,
      source: 'user',
      text: queued.text,
      attachments: queued.attachments,
      timestamp: queued.timestamp,
      order: QUEUED_MESSAGE_ORDER_BASE + index,
    });
  });
  snapshot.sort(messageSort);
  return snapshot;
}

export function buildReplayEvents(store: SessionStore): ReplayEventMessage[] {
  const replayEvents: ReplayEventMessage[] = [
    {
      type: 'session_runtime_snapshot',
      sessionRuntime: store.runtime,
    },
  ];

  const transcript = [...store.transcript].sort(messageSort);
  for (const message of transcript) {
    if (message.source === 'user') {
      replayEvents.push({
        type: 'message_state_changed',
        id: message.id,
        newState: MessageState.ACCEPTED,
        userMessage: {
          text: message.text ?? '',
          timestamp: message.timestamp,
          attachments: message.attachments,
          settings: {
            selectedModel: resolveSelectedModel(DEFAULT_CHAT_SETTINGS.selectedModel),
            reasoningEffort: DEFAULT_CHAT_SETTINGS.reasoningEffort,
            thinkingEnabled: DEFAULT_CHAT_SETTINGS.thinkingEnabled,
            planModeEnabled: DEFAULT_CHAT_SETTINGS.planModeEnabled,
          },
          order: message.order,
        },
      });
      replayEvents.push({
        type: 'message_state_changed',
        id: message.id,
        newState: MessageState.COMMITTED,
      });
      continue;
    }

    if (message.message) {
      replayEvents.push({
        type: 'agent_message',
        data: message.message,
        order: message.order,
      });
    }
  }

  for (const [queuePosition, queued] of store.queue.entries()) {
    replayEvents.push({
      type: 'message_state_changed',
      id: queued.id,
      newState: MessageState.ACCEPTED,
      queuePosition,
      userMessage: {
        text: queued.text,
        timestamp: queued.timestamp,
        attachments: queued.attachments,
        settings: {
          selectedModel: resolveSelectedModel(queued.settings.selectedModel),
          reasoningEffort: queued.settings.reasoningEffort,
          thinkingEnabled: queued.settings.thinkingEnabled,
          planModeEnabled: queued.settings.planModeEnabled,
        },
      },
    });
  }

  if (store.pendingInteractiveRequest) {
    if (store.pendingInteractiveRequest.toolName === 'AskUserQuestion') {
      replayEvents.push({
        type: 'user_question',
        requestId: store.pendingInteractiveRequest.requestId,
        questions: ((store.pendingInteractiveRequest.input as { questions?: unknown[] })
          .questions ?? []) as ReplayEventMessage['questions'],
      });
    } else {
      replayEvents.push({
        type: 'permission_request',
        requestId: store.pendingInteractiveRequest.requestId,
        toolName: store.pendingInteractiveRequest.toolName,
        toolInput: store.pendingInteractiveRequest.input,
        planContent: store.pendingInteractiveRequest.planContent,
      });
    }
  }

  return replayEvents;
}
