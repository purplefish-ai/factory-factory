/** Shared labels for the backward-compatible provider-native permission presets. */
export const NATIVE_PERMISSION_OPTIONS = [
  { value: 'STRICT', label: 'Standard' },
  { value: 'RELAXED', label: 'Accept edits / Auto review' },
  { value: 'YOLO', label: 'Full access' },
] as const;

export const NATIVE_PERMISSION_DESCRIPTION =
  'Standard uses Claude approval prompts and Codex workspace access. Accept edits / Auto review lets Claude accept file edits and Codex review sensitive actions. Full access skips approval prompts.';
