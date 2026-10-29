/** Shared labels for the backward-compatible provider-native permission presets. */
export const NATIVE_PERMISSION_OPTIONS = [
  { value: 'STRICT', label: 'Standard' },
  { value: 'RELAXED', label: 'Auto review' },
  { value: 'YOLO', label: 'Full access' },
] as const;

export const NATIVE_PERMISSION_DESCRIPTION =
  'Standard uses Claude approval prompts and Codex workspace access. Auto review uses Claude Auto mode and Codex Auto review, which replace routine approval prompts with provider-native safety checks; explicit permission rules still apply. Claude uses Accept edits when Auto mode is unavailable. Full access skips approval prompts.';

export function isNativePermissionPreset(
  value: string
): value is (typeof NATIVE_PERMISSION_OPTIONS)[number]['value'] {
  return NATIVE_PERMISSION_OPTIONS.some((option) => option.value === value);
}
