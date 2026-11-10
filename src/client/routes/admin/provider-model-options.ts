import type { SettingOption } from './settings-section';

/** Options shared by the chat defaults and adversarial review selects. */
export const PROVIDER_OPTIONS = [
  { value: 'CLAUDE', label: 'Claude' },
  { value: 'CODEX', label: 'Codex' },
] as const;

export const PROVIDER_DEFAULT_EFFORT = '__provider_default__';

type CatalogOption = { value: string; label: string };

/**
 * Catalog options, plus the saved value when the catalog no longer lists it.
 * `missingLabel` names a saved value the loaded catalog lacks; while the
 * catalog is loading (or failed to load) the raw value is shown instead.
 */
export function withSavedOption(
  options: readonly CatalogOption[] | undefined,
  saved: string,
  missingLabel = saved
): SettingOption<string>[] {
  if (!options) {
    return [{ value: saved, label: saved }];
  }
  return options.some((option) => option.value === saved)
    ? [...options]
    : [{ value: saved, label: missingLabel }, ...options];
}

export function effortOptions(options: readonly CatalogOption[] | undefined, saved: string | null) {
  return [
    { value: PROVIDER_DEFAULT_EFFORT, label: 'Provider default' },
    ...(saved ? withSavedOption(options, saved) : (options ?? [])),
  ];
}

export const toEffort = (value: string) => (value === PROVIDER_DEFAULT_EFFORT ? null : value);
