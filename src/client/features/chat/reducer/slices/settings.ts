import { clampChatSettingsForCapabilities } from '@/client/features/chat/chat-settings';
import type { AcpConfigOption, ChatAction, ChatState } from '@/client/features/chat/reducer/types';

function isModelOption(option: AcpConfigOption): boolean {
  return option.id === 'model' || option.category === 'model';
}

function confirmsModelSelection(state: ChatState, currentModel: string | undefined): boolean {
  const selected = state.chatSettings.selectedModel;
  if (currentModel === selected) {
    return true;
  }
  if (state.chatCapabilities.provider !== 'CLAUDE' || !currentModel) {
    return false;
  }
  const family = /^(sonnet|opus|haiku|fable)(\[1m\])?$/.exec(selected)?.[1];
  return Boolean(
    family &&
    new RegExp(`^claude-${family}-\\d`).test(currentModel) &&
    currentModel.endsWith('[1m]') === selected.endsWith('[1m]')
  );
}

function handleConfigOptionsUpdate(
  state: ChatState,
  payload: { configOptions: AcpConfigOption[] }
): ChatState {
  // Mirror the ACP model option's server-confirmed value into chatSettings. The model chosen
  // through the ACP config selector only lives in acpConfigOptions; without this sync,
  // chatSettings.selectedModel keeps its stale default and the model re-applied at message
  // dispatch (setSessionModel) would clobber the user's pick right before the turn runs.
  const modelOption = payload.configOptions.find(isModelOption);
  const currentModel = modelOption?.currentValue;
  const keepPendingModel =
    state.modelSelectionSource === 'local' && !confirmsModelSelection(state, currentModel);
  const acceptModel = !!currentModel && !keepPendingModel;
  return {
    ...state,
    acpConfigOptions: modelOption
      ? payload.configOptions
      : [...(state.acpConfigOptions?.filter(isModelOption) ?? []), ...payload.configOptions],
    chatSettings: acceptModel
      ? { ...state.chatSettings, selectedModel: currentModel }
      : state.chatSettings,
    modelSelectionSource: acceptModel ? 'server' : state.modelSelectionSource,
    pendingModelRequestId: acceptModel ? null : state.pendingModelRequestId,
  };
}

function handleCapabilitiesUpdate(
  state: ChatState,
  action: Extract<ChatAction, { type: 'WS_CHAT_CAPABILITIES' }>
): ChatState {
  const confirmedModel = action.payload.capabilities.model.selected;
  const adoptModel = state.modelSelectionSource === 'bootstrap' && !!confirmedModel;
  const slashCommandsEnabled = action.payload.capabilities.slashCommands.enabled;
  return {
    ...state,
    chatCapabilities: action.payload.capabilities,
    chatCapabilitiesLoaded: true,
    modelSelectionSource: adoptModel ? 'server' : state.modelSelectionSource,
    chatSettings: clampChatSettingsForCapabilities(
      adoptModel ? { ...state.chatSettings, selectedModel: confirmedModel } : state.chatSettings,
      action.payload.capabilities
    ),
    slashCommands: slashCommandsEnabled ? state.slashCommands : [],
    slashCommandsLoaded: slashCommandsEnabled ? state.slashCommandsLoaded : true,
  };
}

function handleModelRequestFailure(
  state: ChatState,
  action: Extract<ChatAction, { type: 'WS_ERROR' }>
): ChatState {
  if (!action.payload.requestId || action.payload.requestId !== state.pendingModelRequestId) {
    return state;
  }
  const confirmedModel =
    state.acpConfigOptions?.find(isModelOption)?.currentValue ??
    state.chatCapabilities.model.selected;
  return {
    ...state,
    chatSettings: confirmedModel
      ? { ...state.chatSettings, selectedModel: confirmedModel }
      : state.chatSettings,
    modelSelectionSource: confirmedModel ? 'server' : 'bootstrap',
    pendingModelRequestId: null,
  };
}

export function reduceSettingsSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_ERROR':
      return handleModelRequestFailure(state, action);
    case 'UPDATE_SETTINGS':
      return {
        ...state,
        chatSettings: clampChatSettingsForCapabilities(
          { ...state.chatSettings, ...action.payload },
          state.chatCapabilitiesLoaded ? state.chatCapabilities : undefined
        ),
        modelSelectionSource:
          action.payload.selectedModel !== undefined ? 'local' : state.modelSelectionSource,
        pendingModelRequestId:
          action.payload.selectedModel !== undefined
            ? (action.requestId ?? null)
            : state.pendingModelRequestId,
      };
    case 'SET_SETTINGS':
      return {
        ...state,
        chatSettings: clampChatSettingsForCapabilities(
          {
            ...action.payload,
            selectedModel:
              state.modelSelectionSource === 'bootstrap'
                ? action.payload.selectedModel
                : state.chatSettings.selectedModel,
          },
          state.chatCapabilitiesLoaded ? state.chatCapabilities : undefined
        ),
      };
    case 'CONFIG_OPTIONS_UPDATE':
      return handleConfigOptionsUpdate(state, action.payload);
    case 'WS_CHAT_CAPABILITIES':
      return handleCapabilitiesUpdate(state, action);
    default:
      return state;
  }
}
