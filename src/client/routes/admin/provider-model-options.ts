import type { SettingOption } from './settings-section';

/** Options shared by the chat defaults and adversarial review selects. */
export const PROVIDER_OPTIONS = [
  { value: 'CLAUDE', label: 'Claude' },
  { value: 'CODEX', label: 'Codex' },
] as const;

export const PROVIDER_DEFAULT_EFFORT = '__provider_default__';

type CatalogOption = { value: string; label: string };

/** Catalog options, plus the saved value when the catalog no longer lists it. */
export function withSavedOption(
  options: readonly CatalogOption[] | undefined,
  saved: string,
  savedLabel = saved
): SettingOption<string>[] {
  const catalog = options ?? [];
  return catalog.some((option) => option.value === saved)
    ? [...catalog]
    : [{ value: saved, label: savedLabel }, ...catalog];
}

export function effortOptions(options: readonly CatalogOption[] | undefined, saved: string | null) {
  return [
    { value: PROVIDER_DEFAULT_EFFORT, label: 'Provider default' },
    ...(saved ? withSavedOption(options, saved) : (options ?? [])),
  ];
}

export const toEffort = (value: string) => (value === PROVIDER_DEFAULT_EFFORT ? null : value);
