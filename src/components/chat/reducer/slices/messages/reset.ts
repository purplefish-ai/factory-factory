import { DEFAULT_CHAT_SETTINGS } from '@/lib/claude-types';
import { createBaseResetState, createSessionSwitchResetState } from '../../state';
import type { ChatAction, ChatState, SessionStatus } from '../../types';

export function reduceMessageResetSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'CLEAR_CHAT': {
      const sessionStatus: SessionStatus =
        state.sessionStatus.phase === 'running' ? state.sessionStatus : { phase: 'ready' };
      return {
        ...state,
        ...createBaseResetState(),
        sessionStatus,
        chatSettings: DEFAULT_CHAT_SETTINGS,
      };
    }
    case 'RESET_FOR_SESSION_SWITCH':
      return {
        ...state,
        ...createSessionSwitchResetState(),
      };
    default:
      return state;
  }
}
