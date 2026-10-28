import type { SessionLaunchOptions } from '@/shared/session-launch';

interface DraftOptions {
  reasoningEffort?: string | null;
  savedReasoningEffort?: string | null;
  planModeEnabled?: boolean;
}
/** Keep explicit intent, but resolve inherited unsupported preferences to the native default. */
export function getEffectiveLaunchOptions(
  draft: DraftOptions,
  native: SessionLaunchOptions | undefined
) {
  const options = native?.reasoning.options ?? [];
  const saved = draft.savedReasoningEffort;
  const inherited =
    saved && options.some((option) => option.value === saved)
      ? saved
      : (native?.reasoning.defaultValue ?? native?.reasoning.selected);
  const requested = draft.reasoningEffort === undefined ? inherited : draft.reasoningEffort;
  const reasoningEffort = requested === 'default' ? null : requested;
  const invalidReasoning = Boolean(
    native &&
    typeof reasoningEffort === 'string' &&
    !options.some((option) => option.value === reasoningEffort)
  );
  const planModeEnabled = draft.planModeEnabled ?? native?.planMode.selected ?? false;
  const invalidPlan = Boolean(native && planModeEnabled && !native.planMode.supported);
  return { reasoningEffort, planModeEnabled, invalidReasoning, invalidPlan };
}
