import { clampChatSettingsForCapabilities } from '@/components/chat/chat-settings';
import {
  createBaseResetState,
  createSessionSwitchResetState,
} from '@/components/chat/reducer/state';
import type { ChatAction, ChatState, SessionStatus } from '@/components/chat/reducer/types';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';

export function reduceMessageResetSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'CLEAR_CHAT': {
      const sessionStatus: SessionStatus =
        state.sessionStatus.phase === 'running' ? state.sessionStatus : { phase: 'ready' };
      return {
        ...state,
        ...createBaseResetState(),
        sessionStatus,
        chatSettings: clampChatSettingsForCapabilities(
          DEFAULT_CHAT_SETTINGS,
          state.chatCapabilities
        ),
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
