import {
  clampChatSettingsForCapabilities,
  getConfigOptionSettings,
} from '@/client/features/chat/chat-settings';
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

function reconcileNativeSettings(
  state: ChatState,
  configOptions: AcpConfigOption[]
): Partial<ChatState['chatSettings']> {
  const confirmedSettings: Partial<ChatState['chatSettings']> = {};
  if (state.needsConfigReconciliation) {
    const confirmedState = { ...state, acpConfigOptions: configOptions };
    for (const option of configOptions) {
      if (!(isModelOption(option) || state.pendingConfigOptions.has(option.id))) {
        Object.assign(
          confirmedSettings,
          getConfigOptionSettings(confirmedState, option.id, option.currentValue)
        );
      }
    }
  }
  return confirmedSettings;
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
    (modelOption && state.pendingConfigOptions.has(modelOption.id)) ||
    (state.modelSelectionSource === 'local' && !confirmsModelSelection(state, currentModel));
  const acceptModel = !!currentModel && !keepPendingModel;
  const confirmedSettings = reconcileNativeSettings(state, payload.configOptions);
  return {
    ...state,
    needsConfigReconciliation: false,
    acpConfigOptions: modelOption
      ? payload.configOptions
      : [...(state.acpConfigOptions?.filter(isModelOption) ?? []), ...payload.configOptions],
    chatSettings: {
      ...state.chatSettings,
      ...confirmedSettings,
      ...(acceptModel ? { selectedModel: currentModel } : {}),
    },
    modelSelectionSource: acceptModel ? 'server' : state.modelSelectionSource,
    pendingModelRequestId: acceptModel ? null : state.pendingModelRequestId,
  };
}

function handleCapabilitiesUpdate(
  state: ChatState,
  action: Extract<ChatAction, { type: 'WS_CHAT_CAPABILITIES' }>
): ChatState {
  const confirmedModel = action.payload.capabilities.model.selected;
  const adoptModel =
    !!confirmedModel &&
    (state.modelSelectionSource === 'bootstrap' ||
      (state.needsConfigReconciliation && state.modelSelectionSource !== 'local'));
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
  return restoreConfirmedModel(state);
}

function restoreConfirmedModel(state: ChatState): ChatState {
  const confirmedModel =
    state.acpConfigOptions?.find(isModelOption)?.currentValue ??
    state.chatCapabilities.model.selected;
  return {
    ...state,
    chatSettings: confirmedModel
      ? { ...state.chatSettings, selectedModel: confirmedModel }
      : state.chatSettings,
    modelSelectionSource: confirmedModel ? 'server' : state.modelSelectionSource,
    pendingModelRequestId: null,
  };
}

function settleConfigRequest(state: ChatState, requestId: string | undefined): ChatState {
  const entry = Array.from(state.pendingConfigOptions.entries()).find(
    ([, pending]) => pending.requestId === requestId
  );
  if (!entry) {
    return state;
  }
  const [configId] = entry;
  const pendingConfigOptions = new Map(state.pendingConfigOptions);
  pendingConfigOptions.delete(configId);
  const confirmed = state.acpConfigOptions?.find((option) => option.id === configId);
  const settings = confirmed
    ? getConfigOptionSettings(state, configId, confirmed.currentValue)
    : {};
  return {
    ...state,
    pendingConfigOptions,
    chatSettings: { ...state.chatSettings, ...settings },
    ...(settings.selectedModel !== undefined
      ? { modelSelectionSource: 'server' as const, pendingModelRequestId: null }
      : {}),
  };
}

export function reduceSettingsSlice(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'WS_ERROR':
      return handleModelRequestFailure(
        settleConfigRequest(state, action.payload.requestId),
        action
      );
    case 'CONFIG_OPTION_REQUESTED':
      return {
        ...state,
        pendingConfigOptions: new Map(state.pendingConfigOptions).set(action.payload.configId, {
          value: action.payload.value,
          requestId: action.payload.requestId,
        }),
      };
    case 'CONFIG_OPTION_APPLIED':
      return settleConfigRequest(state, action.payload.requestId);
    case 'CONFIG_OPTIONS_DISCONNECTED': {
      const settled = Array.from(state.pendingConfigOptions.values()).reduce<ChatState>(
        (current, pending) => settleConfigRequest(current, pending.requestId),
        { ...state, needsConfigReconciliation: true }
      );
      return settled.modelSelectionSource === 'local' || settled.pendingModelRequestId
        ? restoreConfirmedModel(settled)
        : settled;
    }
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
