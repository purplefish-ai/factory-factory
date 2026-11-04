import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR_SCHEME_IDS, type ColorSchemeId } from '@/shared/appearance';
import { contrastRatio, mixOver, parseThemeColor, type Rgb, rgbToHex } from './lib/color-contrast';
import { getStatusToneStyle, STATUS_TONES } from './lib/status-tones';
import { readThemeDeclarations, resolveThemeVariables, type ThemeMode } from './lib/theme-palette';

/*
 * Guards the status palette documented in docs/status-colors.md: every status
 * token must stay legible as text (WCAG AA, 4.5:1; AAA, 7:1, for the
 * high-contrast scheme) on page and card backgrounds and on its own tint, in
 * every color scheme and mode.
 */

const CSS = `${readFileSync(join(import.meta.dirname, 'globals.css'), 'utf8')}\n${readFileSync(
  join(import.meta.dirname, 'theme-presets.css'),
  'utf8'
)}`;

const STATUS_TOKENS = ['running', 'success', 'warning', 'destructive', 'info', 'merged'] as const;
const MODES: readonly ThemeMode[] = ['light', 'dark'];
const AA = 4.5;
/** Status chips and banners tint their background with 10% of the token. */
const TINT_ALPHA = 0.1;
/** shadcn Button/Badge render destructive at 60% in dark mode. */
const DARK_DESTRUCTIVE_FILL_ALPHA = 0.6;

const CASES = COLOR_SCHEME_IDS.flatMap((scheme) => MODES.map((mode) => [scheme, mode] as const));

function palette(scheme: ColorSchemeId, mode: ThemeMode) {
  const variables = resolveThemeVariables(CSS, scheme, mode);
  return {
    raw: (name: string) => variables.get(`--${name}`),
    color: (name: string): Rgb => {
      const value = variables.get(`--${name}`);
      const parsed = value ? parseThemeColor(value) : null;
      if (parsed?.alpha !== 1) {
        throw new Error(`${scheme}/${mode}: --${name} is not an opaque color (${value})`);
      }
      return parsed.rgb;
    },
  };
}

function textMinimum(scheme: ColorSchemeId): number {
  return scheme === 'high-contrast' ? 7 : AA;
}

describe('status palette', () => {
  it.each(CASES)('%s %s status tokens are legible as text and on tints', (scheme, mode) => {
    const { color } = palette(scheme, mode);
    const background = color('background');
    const card = color('card');
    for (const token of STATUS_TOKENS) {
      const value = color(token);
      const surfaces: Record<string, Rgb> = { background, card };
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        expect
          .soft(contrastRatio(value, surface), `${token} on ${surfaceName}`)
          .toBeGreaterThanOrEqual(textMinimum(scheme));
        expect
          .soft(contrastRatio(value, mixOver(value, surface, TINT_ALPHA)), `${token} on its tint`)
          .toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it.each(CASES)('%s %s keeps text legible on bright accent tints', (scheme, mode) => {
    const { color } = palette(scheme, mode);
    for (const token of STATUS_TOKENS) {
      const accent = color(`${token}-accent`);
      for (const surface of ['background', 'card']) {
        expect(
          contrastRatio(
            color(token),
            mixOver(accent, color(surface), mode === 'dark' ? 0.1 : 0.15)
          ),
          `${token} on ${surface} accent tint`
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it.each(CASES)('%s %s standalone status dots have non-text contrast', (scheme, mode) => {
    const { color } = palette(scheme, mode);
    for (const tone of STATUS_TONES.filter((tone) => tone !== 'neutral')) {
      const token = getStatusToneStyle(tone).dot.replace('bg-', '');
      for (const surface of ['background', 'card']) {
        expect(
          contrastRatio(color(token), color(surface)),
          `${tone} dot on ${surface}`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it.each(CASES)('%s %s foregrounds are legible on solid status fills', (scheme, mode) => {
    const { color } = palette(scheme, mode);
    for (const token of STATUS_TOKENS) {
      // Translucent dark destructive fills composite over whichever surface
      // holds them, so check both the page and cards.
      const fills =
        token === 'destructive' && mode === 'dark'
          ? [color('background'), color('card')].map((surface) =>
              mixOver(color(token), surface, DARK_DESTRUCTIVE_FILL_ALPHA)
            )
          : [color(token)];
      for (const fill of fills) {
        expect
          .soft(contrastRatio(color(`${token}-foreground`), fill), `${token}-foreground`)
          .toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it.each(CASES)('%s %s status tokens are distinct from each other', (scheme, mode) => {
    const { color } = palette(scheme, mode);
    // Compare rendered colors so equivalent syntaxes cannot pass as distinct.
    const values = STATUS_TOKENS.map((token) => rgbToHex(color(token)));
    expect(new Set(values).size).toBe(STATUS_TOKENS.length);
  });

  it.each(CASES)('%s %s neutral status text is legible', (scheme, mode) => {
    const { color } = palette(scheme, mode);
    for (const surface of ['background', 'card', 'muted']) {
      expect
        .soft(contrastRatio(color('muted-foreground'), color(surface)), `on ${surface}`)
        .toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(MODES)('keeps factory warning and focus rings separate from the brand in %s', (mode) => {
    const { raw } = palette('factory', mode);
    expect(raw('warning')).not.toBe(raw('brand'));
    expect(raw('ring')).not.toBe(raw('brand'));
  });

  it.each(COLOR_SCHEME_IDS.filter((scheme) => scheme !== 'factory'))(
    'gives always-dark %s surfaces (nested .dark) the same palette as dark mode',
    (scheme) => {
      // The dark block also matches `.dark` descendants. A nested `.dark` sits
      // under the light block only through inheritance, so it resolves like
      // dark mode only if the dark block redeclares every light-block token.
      const light = readThemeDeclarations(CSS, `:root[data-color-scheme='${scheme}']`);
      const dark = readThemeDeclarations(CSS, `:root[data-color-scheme='${scheme}'].dark`);
      expect(readThemeDeclarations(CSS, `:root[data-color-scheme='${scheme}'] .dark`)).toEqual(
        dark
      );
      expect([...light.keys()].filter((name) => !dark.has(name))).toEqual([]);
    }
  );

  it.each(COLOR_SCHEME_IDS.filter((scheme) => scheme !== 'factory'))(
    'declares %s status overrides in both modes so light values cannot leak into dark',
    (scheme) => {
      const light = readThemeDeclarations(CSS, `:root[data-color-scheme='${scheme}']`);
      const dark = readThemeDeclarations(CSS, `:root[data-color-scheme='${scheme}'].dark`);
      for (const token of STATUS_TOKENS.flatMap((name) => [name, `${name}-foreground`])) {
        expect(light.has(`--${token}`), `light --${token}`).toBe(true);
        expect(dark.has(`--${token}`), `dark --${token}`).toBe(true);
      }
    }
  );
});
