import type { ChatSettings } from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

export function clampChatSettingsForCapabilities(
  settings: ChatSettings,
  capabilities: ChatBarCapabilities
): ChatSettings {
  const modelValues = new Set(capabilities.model.options.map((option) => option.value));
  const reasoningValues = new Set(capabilities.reasoning.options.map((option) => option.value));
  const selectedModel = (() => {
    if (!capabilities.model.enabled) {
      return settings.selectedModel;
    }

    if (settings.selectedModel && modelValues.has(settings.selectedModel)) {
      return settings.selectedModel;
    }

    if (capabilities.model.selected && modelValues.has(capabilities.model.selected)) {
      return capabilities.model.selected;
    }

    return capabilities.model.options[0]?.value ?? settings.selectedModel;
  })();

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

    return capabilities.reasoning.options[0]?.value ?? null;
  })();

  return {
    selectedModel,
    reasoningEffort,
    thinkingEnabled: capabilities.thinking.enabled ? settings.thinkingEnabled : false,
    planModeEnabled: capabilities.planMode.enabled ? settings.planModeEnabled : false,
  };
}
