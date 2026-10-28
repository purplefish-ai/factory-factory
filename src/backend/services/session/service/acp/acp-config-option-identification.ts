type ConfigOptionIdentity = { id: string; category?: string | null };
export type NativeModeKind = 'mode' | 'collaboration_mode';

/** Native adapters may identify standard controls by category, ID, or both. */
export function isReasoningConfigOption(option: ConfigOptionIdentity): boolean {
  return (
    option.category === 'thought_level' ||
    option.category === 'reasoning' ||
    option.id === 'reasoning_effort' ||
    option.id === 'thought_level'
  );
}
export function isNativeModeConfigOption(
  option: ConfigOptionIdentity,
  kind: NativeModeKind
): boolean {
  return option.id === kind || option.category === kind;
}
