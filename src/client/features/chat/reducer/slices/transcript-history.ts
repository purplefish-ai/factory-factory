import { applyRendererMessages } from '@/client/features/chat/reducer/helpers';
import type { ChatAction, ChatState } from '@/client/features/chat/reducer/types';

export function reduceTranscriptHistory(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'TRANSCRIPT_HISTORY_START') {
    if (
      state.transcriptHistory.status === 'loading' ||
      state.transcriptHistory.status === 'complete'
    ) {
      return state;
    }
    // Virtualization bounds DOM work; retain explicitly requested history in memory
    // so ongoing live activity cannot trim away the user's reading position.
    return {
      ...state,
      rendererTranscriptLimit: null,
      transcriptPageBoundaries: new Set([
        ...state.transcriptPageBoundaries,
        action.beforeMessageId,
      ]),
      transcriptHistory: {
        status: 'loading',
        requestId: action.requestId,
        previousLimit: state.rendererTranscriptLimit,
        previousBoundaries: state.transcriptPageBoundaries,
      },
    };
  }
  if (action.type !== 'TRANSCRIPT_HISTORY_LOADED' && action.type !== 'TRANSCRIPT_HISTORY_FAILED') {
    return state;
  }
  if (
    state.transcriptHistory.status !== 'loading' ||
    state.transcriptHistory.requestId !== action.requestId
  ) {
    return state;
  }
  if (action.type === 'TRANSCRIPT_HISTORY_FAILED') {
    return {
      ...state,
      rendererTranscriptLimit: state.transcriptHistory.previousLimit,
      transcriptPageBoundaries: state.transcriptHistory.previousBoundaries,
      transcriptHistory: { status: 'error', error: action.error },
    };
  }
  // Never replay historical events through live side effects (usage, thinking,
  // tasks, runtime). Existing live entries win overlaps with the fetched page.
  const removedMessageIds = state.transcriptHistory.removedMessageIds;
  const messages = new Map(
    action.messages
      .filter((message) => !removedMessageIds?.has(message.id))
      .map((message) => [message.id, message])
  );
  for (const message of state.messages) {
    messages.set(message.id, message);
  }
  return applyRendererMessages(
    { ...state, transcriptHistory: { status: action.hasMore ? 'idle' : 'complete' } },
    [...messages.values()]
  );
}
