import type { ChatSettings } from '@/lib/claude-types';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

export function clampChatSettingsForCapabilities(
  settings: ChatSettings,
  capabilities: ChatBarCapabilities
): ChatSettings {
  const modelValues = new Set(capabilities.model.options.map((option) => option.value));
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

  return {
    selectedModel,
    thinkingEnabled: capabilities.thinking.enabled ? settings.thinkingEnabled : false,
    planModeEnabled: capabilities.planMode.enabled ? settings.planModeEnabled : false,
  };
}
