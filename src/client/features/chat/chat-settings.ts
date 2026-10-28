import type { ChatSettings } from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type { ChatState } from './reducer/types';

export function clampChatSettingsForCapabilities(
  settings: ChatSettings,
  capabilities: ChatBarCapabilities | undefined
): ChatSettings {
  // Missing capabilities mean configuration is still loading, not unsupported.
  if (!capabilities) {
    return settings;
  }
  const reasoningValues = new Set(capabilities.reasoning.options.map((option) => option.value));
  const reasoningEffort = (() => {
    if (!capabilities.reasoning.enabled) {
      return null;
    }

    if (settings.reasoningEffort && reasoningValues.has(settings.reasoningEffort)) {
      return settings.reasoningEffort;
    }

    if (capabilities.reasoning.selected && reasoningValues.has(capabilities.reasoning.selected)) {
      return capabilities.reasoning.selected;
    }

    return null;
  })();

  return {
    // The model is owned by confirmed server configuration or an explicit user edit.
    // A partial/stale catalog must never silently substitute another model.
    selectedModel: settings.selectedModel,
    reasoningEffort,
    thinkingEnabled: capabilities.thinking.enabled ? settings.thinkingEnabled : false,
    planModeEnabled: capabilities.planMode.enabled ? settings.planModeEnabled : false,
  };
}

export function getConfigOptionSettings(
  state: ChatState,
  configId: string,
  value: string
): Partial<ChatSettings> {
  const changedOption = state.acpConfigOptions?.find((option) => option.id === configId);
  const isModelOption = configId === 'model' || changedOption?.category === 'model';
  const isPlanningOption =
    state.chatCapabilities.provider === 'CODEX'
      ? configId === 'collaboration_mode' || changedOption?.category === 'collaboration_mode'
      : configId === 'mode' || changedOption?.category === 'mode';
  const settings: Partial<ChatSettings> = {};
  if (isPlanningOption) {
    settings.planModeEnabled = value === 'plan';
  }
  if (isModelOption) {
    settings.selectedModel = value;
  }
  if (configId === 'reasoning_effort' || changedOption?.category === 'thought_level') {
    settings.reasoningEffort = value;
  }
  return settings;
}
