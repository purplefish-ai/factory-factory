/**
 * Appearance preferences: color scheme presets, background/text overrides,
 * a global font-size scale, and interface/monospace font families.
 *
 * Shared between the backend (tRPC validation, backup import) and the client
 * (settings UI, applying the preferences to the document).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Color schemes
// ---------------------------------------------------------------------------

export const COLOR_SCHEME_IDS = ['factory', 'github', 'one', 'solarized', 'high-contrast'] as const;
export type ColorSchemeId = (typeof COLOR_SCHEME_IDS)[number];
export const DEFAULT_COLOR_SCHEME: ColorSchemeId = 'factory';

export interface ColorSchemeOption {
  id: ColorSchemeId;
  label: string;
  description: string;
}

/** Each scheme ships a light and a dark variant; the light/dark toggle picks between them. */
export const COLOR_SCHEME_OPTIONS: readonly ColorSchemeOption[] = [
  { id: 'factory', label: 'Factory', description: 'Neutral grays with the Factory yellow accent' },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Inspired by GitHub’s Primer light and dark themes',
  },
  { id: 'one', label: 'One', description: 'Inspired by Atom One Light and One Dark' },
  {
    id: 'solarized',
    label: 'Solarized',
    description: 'Ethan Schoonover’s Solarized light and dark',
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    description: 'Pure black and white with strong borders for low vision',
  },
];

export const colorSchemeIdSchema = z.enum(COLOR_SCHEME_IDS);

/** Maps unknown or legacy scheme ids back to the default instead of failing. */
export function normalizeColorScheme(value: unknown): ColorSchemeId {
  const parsed = colorSchemeIdSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_COLOR_SCHEME;
}

// ---------------------------------------------------------------------------
// Color overrides
// ---------------------------------------------------------------------------

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Expands `#rgb` to `#rrggbb` and lowercases, so `<input type="color">` accepts it. */
export function normalizeHexColor(value: string): string {
  const hex = value.trim().toLowerCase();
  if (hex.length === 4) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex;
}

/** `#rgb` or `#rrggbb`, normalized to lowercase `#rrggbb`. */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOR_PATTERN, 'Color must be a hex value such as #1e1e1e')
  .transform(normalizeHexColor);

/** Returns the normalized color, or null when the value is not a hex color. */
export function parseHexColor(value: unknown): string | null {
  const parsed = hexColorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Font scale
// ---------------------------------------------------------------------------

/** Percentage applied to the root font size; every rem-based size follows it. */
export const FONT_SCALE_MIN = 75;
export const FONT_SCALE_MAX = 175;
export const FONT_SCALE_STEP = 5;
export const DEFAULT_FONT_SCALE = 100;

export const fontScaleSchema = z.number().int().min(FONT_SCALE_MIN).max(FONT_SCALE_MAX);

export function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_FONT_SCALE;
  }
  const stepped = Math.round(value / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, stepped));
}

/** The terminal is sized in pixels by xterm.js, so it scales explicitly. */
export const BASE_TERMINAL_FONT_SIZE = 13;

export function scaledTerminalFontSize(fontScale: number): number {
  return Math.max(8, Math.round((BASE_TERMINAL_FONT_SIZE * clampFontScale(fontScale)) / 100));
}

// ---------------------------------------------------------------------------
// Font families
// ---------------------------------------------------------------------------

export interface FontFamilyOption {
  id: string;
  label: string;
  /** CSS `font-family` value; `null` keeps the application default. */
  value: string | null;
}

export const DEFAULT_FONT_OPTION_ID = 'default';
export const CUSTOM_FONT_OPTION_ID = 'custom';

export const SANS_FONT_OPTIONS: readonly FontFamilyOption[] = [
  { id: DEFAULT_FONT_OPTION_ID, label: 'Geist (default)', value: null },
  { id: 'inter', label: 'Inter', value: '"Inter", ui-sans-serif, system-ui, sans-serif' },
  {
    id: 'atkinson',
    label: 'Atkinson Hyperlegible',
    value:
      '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", ui-sans-serif, system-ui, sans-serif',
  },
  {
    id: 'system',
    label: 'System UI',
    value: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
];

export const MONO_FONT_OPTIONS: readonly FontFamilyOption[] = [
  { id: DEFAULT_FONT_OPTION_ID, label: 'Geist Mono (default)', value: null },
  { id: 'plex-mono', label: 'IBM Plex Mono', value: '"IBM Plex Mono", ui-monospace, monospace' },
  {
    id: 'atkinson-mono',
    label: 'Atkinson Hyperlegible Mono',
    value: '"Atkinson Hyperlegible Mono", ui-monospace, monospace',
  },
  {
    id: 'system-mono',
    label: 'System monospace',
    value: 'ui-monospace, Menlo, Monaco, "Cascadia Code", Consolas, monospace',
  },
];

export const FONT_FAMILY_MAX_LENGTH = 200;

/**
 * Only characters that can appear in a `font-family` list. This keeps a saved
 * value from smuggling other declarations (`;`, `{`, `url(`) into the style
 * attribute it is written to.
 */
const FONT_FAMILY_PATTERN = /^[A-Za-z0-9 ,"'._-]+$/;

export const fontFamilySchema = z
  .string()
  .trim()
  .min(1, 'Font family cannot be empty')
  .max(FONT_FAMILY_MAX_LENGTH, `Font family must be at most ${FONT_FAMILY_MAX_LENGTH} characters`)
  .regex(
    FONT_FAMILY_PATTERN,
    'Font family may only contain letters, numbers, spaces, quotes, commas, periods and hyphens'
  );

export function isValidFontFamily(value: unknown): value is string {
  return fontFamilySchema.safeParse(value).success;
}

/** Finds the preset whose value matches, or the custom marker when none does. */
export function fontOptionIdForValue(
  options: readonly FontFamilyOption[],
  value: string | null
): string {
  const match = options.find((option) => option.value === value);
  return match ? match.id : CUSTOM_FONT_OPTION_ID;
}

// ---------------------------------------------------------------------------
// Combined settings
// ---------------------------------------------------------------------------

export const appearanceSettingsSchema = z.object({
  colorScheme: colorSchemeIdSchema,
  backgroundColor: hexColorSchema.nullable(),
  foregroundColor: hexColorSchema.nullable(),
  fontScale: fontScaleSchema,
  fontSans: fontFamilySchema.nullable(),
  fontMono: fontFamilySchema.nullable(),
});

export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  colorScheme: DEFAULT_COLOR_SCHEME,
  backgroundColor: null,
  foregroundColor: null,
  fontScale: DEFAULT_FONT_SCALE,
  fontSans: null,
  fontMono: null,
};

/** The `UserSettings` columns that hold appearance preferences. */
export interface AppearanceUserSettingsFields {
  appearanceColorScheme: string;
  appearanceBackgroundColor: string | null;
  appearanceForegroundColor: string | null;
  appearanceFontScale: number;
  appearanceFontSans: string | null;
  appearanceFontMono: string | null;
}

/**
 * Reads appearance preferences off a `UserSettings` row, falling back to the
 * default for any value the current client can't apply (a scheme that no
 * longer exists, a hand-edited color, an out-of-range scale).
 */
export function appearanceFromUserSettings(
  settings: Partial<AppearanceUserSettingsFields> | null | undefined
): AppearanceSettings {
  if (!settings) {
    return DEFAULT_APPEARANCE;
  }
  return {
    colorScheme: normalizeColorScheme(settings.appearanceColorScheme),
    backgroundColor: parseHexColor(settings.appearanceBackgroundColor),
    foregroundColor: parseHexColor(settings.appearanceForegroundColor),
    fontScale: clampFontScale(settings.appearanceFontScale ?? DEFAULT_FONT_SCALE),
    fontSans: isValidFontFamily(settings.appearanceFontSans) ? settings.appearanceFontSans : null,
    fontMono: isValidFontFamily(settings.appearanceFontMono) ? settings.appearanceFontMono : null,
  };
}

export function isDefaultAppearance(appearance: AppearanceSettings): boolean {
  return (
    appearance.colorScheme === DEFAULT_APPEARANCE.colorScheme &&
    appearance.backgroundColor === null &&
    appearance.foregroundColor === null &&
    appearance.fontScale === DEFAULT_FONT_SCALE &&
    appearance.fontSans === null &&
    appearance.fontMono === null
  );
}
