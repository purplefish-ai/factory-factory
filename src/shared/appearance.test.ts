import { describe, expect, it } from 'vitest';
import {
  appearanceFromUserSettings,
  appearanceSettingsSchema,
  COLOR_SCHEME_IDS,
  COLOR_SCHEME_OPTIONS,
  CUSTOM_FONT_OPTION_ID,
  clampFontScale,
  DEFAULT_APPEARANCE,
  DEFAULT_FONT_OPTION_ID,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  fontFamilySchema,
  fontOptionIdForValue,
  fontScaleSchema,
  hexColorSchema,
  isDefaultAppearance,
  MONO_FONT_OPTIONS,
  normalizeColorScheme,
  SANS_FONT_OPTIONS,
  scaledTerminalFontSize,
} from './appearance';

describe('color schemes', () => {
  it('lists every scheme id exactly once', () => {
    expect(COLOR_SCHEME_OPTIONS.map((option) => option.id)).toEqual([...COLOR_SCHEME_IDS]);
  });

  it('falls back to the default scheme for unknown ids', () => {
    expect(normalizeColorScheme('github')).toBe('github');
    expect(normalizeColorScheme('dracula')).toBe('factory');
    expect(normalizeColorScheme(undefined)).toBe('factory');
  });
});

describe('hexColorSchema', () => {
  it('accepts 3 and 6 digit hex colors and lowercases them', () => {
    expect(hexColorSchema.parse('#ABC')).toBe('#aabbcc');
    expect(hexColorSchema.parse(' #1E1E1E ')).toBe('#1e1e1e');
  });

  it('rejects anything that is not a hex color', () => {
    for (const value of ['red', '#12345', '1e1e1e', '#ggg', 'url(x)', '#1e1e1e; color: red']) {
      expect(hexColorSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('font scale', () => {
  it('clamps and snaps to the step', () => {
    expect(clampFontScale(100)).toBe(100);
    expect(clampFontScale(103)).toBe(105);
    expect(clampFontScale(10)).toBe(FONT_SCALE_MIN);
    expect(clampFontScale(900)).toBe(FONT_SCALE_MAX);
    expect(clampFontScale(Number.NaN)).toBe(100);
  });

  it('only accepts saved scales on the slider step', () => {
    expect(fontScaleSchema.safeParse(105).success).toBe(true);
    expect(fontScaleSchema.safeParse(102).success).toBe(false);
    expect(fontScaleSchema.safeParse(102.5).success).toBe(false);
  });

  it('scales the terminal font size from its pixel base', () => {
    expect(scaledTerminalFontSize(100)).toBe(13);
    expect(scaledTerminalFontSize(150)).toBe(20);
    expect(scaledTerminalFontSize(75)).toBe(10);
  });
});

describe('fontFamilySchema', () => {
  it('accepts font stacks with quotes, commas and hyphens', () => {
    expect(fontFamilySchema.parse(' "Atkinson Hyperlegible", ui-sans-serif, sans-serif ')).toBe(
      '"Atkinson Hyperlegible", ui-sans-serif, sans-serif'
    );
    expect(fontFamilySchema.safeParse('OpenDyslexic').success).toBe(true);
  });

  it('accepts font names in any script', () => {
    expect(fontFamilySchema.parse('游ゴシック, sans-serif')).toBe('游ゴシック, sans-serif');
    expect(fontFamilySchema.safeParse('"Noto Sans Devanagari", देवनागरी').success).toBe(true);
  });

  it('rejects values that could escape a font-family declaration', () => {
    for (const value of ['', 'Inter; color: red', 'url(evil)', 'Inter }', 'a'.repeat(201)]) {
      expect(fontFamilySchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('maps stored values back to preset ids or custom', () => {
    expect(fontOptionIdForValue(SANS_FONT_OPTIONS, null)).toBe(DEFAULT_FONT_OPTION_ID);
    const inter = SANS_FONT_OPTIONS.find((option) => option.id === 'inter');
    expect(fontOptionIdForValue(SANS_FONT_OPTIONS, inter?.value ?? null)).toBe('inter');
    expect(fontOptionIdForValue(MONO_FONT_OPTIONS, 'Fira Code')).toBe(CUSTOM_FONT_OPTION_ID);
  });
});

describe('appearanceFromUserSettings', () => {
  it('returns defaults when settings are missing', () => {
    expect(appearanceFromUserSettings(null)).toEqual(DEFAULT_APPEARANCE);
    expect(appearanceFromUserSettings(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(isDefaultAppearance(appearanceFromUserSettings({}))).toBe(true);
  });

  it('reads valid values and normalizes them', () => {
    const appearance = appearanceFromUserSettings({
      appearanceColorScheme: 'solarized',
      appearanceBackgroundColor: '#FDF6E3',
      appearanceForegroundColor: null,
      appearanceFontScale: 125,
      appearanceFontSans: 'Inter',
      appearanceFontMono: null,
    });
    expect(appearance).toEqual({
      colorScheme: 'solarized',
      backgroundColor: '#fdf6e3',
      foregroundColor: null,
      fontScale: 125,
      fontSans: 'Inter',
      fontMono: null,
    });
    expect(appearanceSettingsSchema.safeParse(appearance).success).toBe(true);
    expect(isDefaultAppearance(appearance)).toBe(false);
  });

  it('drops values the client cannot apply instead of failing', () => {
    const appearance = appearanceFromUserSettings({
      appearanceColorScheme: 'retired-scheme',
      appearanceBackgroundColor: 'not-a-color',
      appearanceForegroundColor: '#fff',
      appearanceFontScale: 1000,
      appearanceFontSans: 'Inter; background: url(x)',
      appearanceFontMono: 'Fira Code',
    });
    expect(appearance).toEqual({
      colorScheme: 'factory',
      backgroundColor: null,
      foregroundColor: '#ffffff',
      fontScale: FONT_SCALE_MAX,
      fontSans: null,
      fontMono: 'Fira Code',
    });
  });
});
