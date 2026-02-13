import { clampChatSettingsForCapabilities } from '@/components/chat/chat-settings';
import type { ChatAction, ChatState } from '@/components/chat/reducer/types';

export function reduceSettingsSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'UPDATE_SETTINGS':
      return {
        ...state,
        chatSettings: clampChatSettingsForCapabilities(
          { ...state.chatSettings, ...action.payload },
          state.chatCapabilities
        ),
      };
    case 'SET_SETTINGS':
      return {
        ...state,
        chatSettings: clampChatSettingsForCapabilities(action.payload, state.chatCapabilities),
      };
    case 'WS_CHAT_CAPABILITIES': {
      const slashCommandsEnabled = action.payload.capabilities.slashCommands.enabled;
      return {
        ...state,
        chatCapabilities: action.payload.capabilities,
        chatSettings: clampChatSettingsForCapabilities(
          state.chatSettings,
          action.payload.capabilities
        ),
        slashCommands: slashCommandsEnabled ? state.slashCommands : [],
        slashCommandsLoaded: slashCommandsEnabled ? state.slashCommandsLoaded : true,
      };
    }
    default:
      return state;
  }
}
