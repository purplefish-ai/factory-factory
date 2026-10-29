/** Shared labels for the backward-compatible provider-native permission presets. */
export const NATIVE_PERMISSION_OPTIONS = [
  { value: 'STRICT', label: 'Standard' },
  { value: 'RELAXED', label: 'Auto review' },
  { value: 'YOLO', label: 'Full access' },
] as const;

export const NATIVE_PERMISSION_DESCRIPTION =
  'Standard uses Claude approval prompts and Codex workspace access. Auto review uses Claude Auto mode and Codex Auto review, which only ask about actions they flag as risky; Claude uses Accept edits on models without Auto mode. Full access skips approval prompts.';

export function isNativePermissionPreset(
  value: string
): value is (typeof NATIVE_PERMISSION_OPTIONS)[number]['value'] {
  return NATIVE_PERMISSION_OPTIONS.some((option) => option.value === value);
}
