import { clampChatSettingsForCapabilities } from '@/components/chat/chat-settings';
import type { AcpConfigOption, ChatAction, ChatState } from '@/components/chat/reducer/types';

function handleConfigOptionsUpdate(
  state: ChatState,
  payload: { configOptions: AcpConfigOption[] }
): ChatState {
  return { ...state, acpConfigOptions: payload.configOptions };
}

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
    case 'CONFIG_OPTIONS_UPDATE':
      return handleConfigOptionsUpdate(state, action.payload);
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
