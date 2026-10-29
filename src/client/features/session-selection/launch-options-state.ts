import type { SessionPermissionPreset } from '@/shared/core';
import { resolveLaunchAccessMode, type SessionLaunchOptions } from '@/shared/session-launch';

interface DraftOptions {
  provider?: string | null;
  accessMode?: string;
  savedAccessPreset?: SessionPermissionPreset;
  reasoningEffort?: string | null;
  savedReasoningEffort?: string | null;
  planModeEnabled?: boolean;
}
/** Preserve explicit intent; only unsupported inherited thinking falls back to native defaults. */
export function getEffectiveLaunchOptions(
  draft: DraftOptions,
  native: SessionLaunchOptions | undefined
) {
  const options = native?.reasoning.options ?? [];
  const saved = draft.savedReasoningEffort;
  const inherited =
    saved === null || (saved && options.some((option) => option.value === saved))
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
  return {
    reasoningEffort,
    planModeEnabled,
    invalidReasoning,
    invalidPlan,
    ...getAccessOptions(draft, native),
  };
}

function getAccessOptions(draft: DraftOptions, native: SessionLaunchOptions | undefined) {
  const accessOptions = native?.accessMode?.options ?? [];
  const accessMode =
    draft.accessMode ??
    resolveLaunchAccessMode(
      draft.provider ?? 'CLAUDE',
      draft.savedAccessPreset ?? 'STRICT',
      accessOptions.map((option) => option.value)
    );
  const invalidAccess = Boolean(
    native &&
    (accessMode
      ? !accessOptions.some((option) => option.value === accessMode)
      : accessOptions.length)
  );
  return { accessMode, invalidAccess };
}
