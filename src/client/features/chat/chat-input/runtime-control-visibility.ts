import type { AcpConfigOption } from '@/client/features/chat/reducer';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';

export interface RuntimeControlVisibilityInput {
  capabilities?: ChatBarCapabilities;
  acpConfigOptions?: AcpConfigOption[] | null;
  /** Native options are only rendered when the agent's config can be edited. */
  onSetConfigOption?: (configId: string, value: string) => void;
}

function providesPlanning(option: AcpConfigOption) {
  const planningIds = ['collaboration_mode', 'plan_mode'];
  if (planningIds.includes(option.id) || planningIds.includes(option.category ?? '')) {
    return true;
  }
  return (
    (option.id === 'mode' || option.category === 'mode') &&
    option.options.some((entry) =>
      'group' in entry
        ? entry.options.some((choice) => choice.value === 'plan')
        : entry.value === 'plan'
    )
  );
}

/**
 * Decides which native ACP options render and which legacy capability controls
 * remain visible, so the toolbar and keyboard shortcuts never drive a setting
 * that a native control already owns.
 */
export function getRuntimeControlVisibility({
  capabilities,
  acpConfigOptions,
  onSetConfigOption,
}: RuntimeControlVisibilityInput) {
  const modelOption = acpConfigOptions?.find(
    (option) => option.category === 'model' || option.id === 'model'
  );
  const nativeOptions = onSetConfigOption
    ? (acpConfigOptions ?? []).filter((option) => option !== modelOption)
    : [];
  const hasNative = (...ids: string[]) =>
    nativeOptions.some((option) => ids.includes(option.id) || ids.includes(option.category ?? ''));
  const hasNativeReasoning = hasNative('reasoning', 'reasoning_effort', 'effort', 'thought_level');
  const hasNativePlanning = nativeOptions.some(providesPlanning);
  return {
    modelOption,
    nativeOptions,
    showReasoning:
      capabilities?.reasoning.enabled === true &&
      capabilities.reasoning.options.length > 0 &&
      !hasNativeReasoning,
    showThinking:
      capabilities?.thinking.enabled === true && !hasNative('thinking') && !hasNativeReasoning,
    showPlanning: capabilities?.planMode.enabled === true && !hasNativePlanning,
  };
}
