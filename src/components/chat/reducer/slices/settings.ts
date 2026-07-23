import { clampChatSettingsForCapabilities } from '@/components/chat/chat-settings';
import type { AcpConfigOption, ChatAction, ChatState } from '@/components/chat/reducer/types';

function handleConfigOptionsUpdate(
  state: ChatState,
  payload: { configOptions: AcpConfigOption[] }
): ChatState {
  // Mirror the ACP model option's server-confirmed value into chatSettings. The model chosen
  // through the ACP config selector only lives in acpConfigOptions; without this sync,
  // chatSettings.selectedModel keeps its stale default and the model re-applied at message
  // dispatch (setSessionModel) would clobber the user's pick right before the turn runs.
  const modelOption = payload.configOptions.find(
    (option) => option.id === 'model' || option.category === 'model'
  );
  const currentModel = modelOption?.currentValue;
  const chatSettings =
    currentModel && currentModel !== state.chatSettings.selectedModel
      ? { ...state.chatSettings, selectedModel: currentModel }
      : state.chatSettings;
  return { ...state, acpConfigOptions: payload.configOptions, chatSettings };
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
