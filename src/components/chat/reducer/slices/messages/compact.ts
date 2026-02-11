import type { ChatAction, ChatState } from '@/components/chat/reducer/types';
import type { ChatMessage, ClaudeMessage } from '@/lib/claude-types';

export function reduceMessageCompactSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'COMPACT_BOUNDARY': {
      const maxOrder = state.messages.reduce((max, m) => Math.max(max, m.order), -1);
      const compactBoundaryMessage: ChatMessage = {
        id: `compact-boundary-${Date.now()}`,
        source: 'claude',
        message: {
          type: 'system',
          subtype: 'compact_boundary',
        } as ClaudeMessage,
        timestamp: new Date().toISOString(),
        order: maxOrder + 1,
      };
      return {
        ...state,
        hasCompactBoundary: true,
        messages: [...state.messages, compactBoundaryMessage],
      };
    }
    default:
      return state;
  }
}
