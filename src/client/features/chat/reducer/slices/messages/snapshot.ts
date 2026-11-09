import {
  applyRendererMessages,
  convertPendingRequest,
} from '@/client/features/chat/reducer/helpers';
import type {
  ChatAction,
  ChatState,
  PendingMessageContent,
} from '@/client/features/chat/reducer/types';
import { compareTranscriptMessageOrder } from '@/lib/chat-protocol';

type SnapshotPayload = Extract<ChatAction, { type: 'SESSION_SNAPSHOT' }>['payload'];
type SnapshotHistory = Pick<
  ChatState,
  'messages' | 'transcriptHistory' | 'rendererTranscriptLimit' | 'transcriptPageBoundaries'
>;

function selectSnapshotHistory(state: ChatState, payload: SnapshotPayload): SnapshotHistory {
  // An empty backend snapshot is authoritative for the whole transcript.
  // Reset request identities too, so an older response cannot repopulate it.
  if (
    payload.isHydration ||
    payload.messages.length === 0 ||
    state.transcriptPageBoundaries.size === 0
  ) {
    return {
      messages: payload.messages,
      transcriptHistory: { status: 'idle' },
      rendererTranscriptLimit:
        state.transcriptPageBoundaries.size > 0 ? undefined : state.rendererTranscriptLimit,
      transcriptPageBoundaries: new Set(),
    };
  }
  const first = payload.messages[0];
  const removedIds = new Set(payload.removedMessageIds);
  // The snapshot owns its recent window; only the separately loaded prefix
  // survives, excluding explicit removals even outside the recent window.
  const prefix = first
    ? state.messages.filter(
        (message) =>
          compareTranscriptMessageOrder(message, first) < 0 && !removedIds.has(message.id)
      )
    : [];
  let transcriptHistory = state.transcriptHistory;
  if (transcriptHistory.status === 'loading' && removedIds.size > 0) {
    transcriptHistory = {
      ...transcriptHistory,
      removedMessageIds: new Set([...(transcriptHistory.removedMessageIds ?? []), ...removedIds]),
    };
  }
  return {
    messages: [...prefix, ...payload.messages],
    transcriptHistory,
    rendererTranscriptLimit: state.rendererTranscriptLimit,
    transcriptPageBoundaries: state.transcriptPageBoundaries,
  };
}

export function reduceMessageSnapshotSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SESSION_SNAPSHOT': {
      const history = selectSnapshotHistory(state, action.payload);
      const snapshotMessages = history.messages;
      const snapshotIds = new Set(snapshotMessages.map((m) => m.id));
      const newPendingMessages = new Map<string, PendingMessageContent>();
      for (const [id, content] of state.pendingMessages) {
        if (!snapshotIds.has(id)) {
          newPendingMessages.set(id, content);
        }
      }

      const pendingRequest = convertPendingRequest(action.payload.pendingInteractiveRequest);
      const queuedMessages = new Map(
        action.payload.queuedMessages.map((queued) => [queued.id, queued] as const)
      );

      return applyRendererMessages(
        {
          ...state,
          ...history,
          messages: [],
          latestThinking: null,
          latestThinkingDeltaOrder: null,
          latestThinkingOrder: snapshotMessages.reduce<number | null>(
            (latest, message) =>
              message.source === 'agent' && message.order >= 0
                ? Math.max(latest ?? message.order, message.order)
                : latest,
            null
          ),
          acpPlan: action.payload.acpPlan ?? null,
          queuedMessages,
          pendingRequest,
          sessionRuntime: action.payload.sessionRuntime,
          toolUseIdToIndex: new Map(),
          agentMessageOrderToIndex: new Map(),
          pendingMessages: newPendingMessages,
          lastRejectedMessage: state.lastRejectedMessage,
        },
        snapshotMessages
      );
    }
    default:
      return state;
  }
}
