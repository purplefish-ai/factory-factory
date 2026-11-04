/**
 * Resolves the theme custom properties declared in `globals.css` and
 * `theme-presets.css` for one color scheme and mode, following the cascade the
 * browser applies: base `:root` < `.dark` < `:root[data-color-scheme]` <
 * `:root[data-color-scheme].dark`. A preset's light block therefore also
 * applies in dark mode unless its dark block redeclares the property.
 *
 * Only plain declaration blocks are read; this is a test and Storybook helper,
 * not a general CSS parser.
 */

import type { ColorSchemeId } from '@/shared/appearance';

export type ThemeMode = 'light' | 'dark';

const COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const DECLARATION_PATTERN = /(--[\w-]+)\s*:\s*([^;]+);/g;
const VAR_PATTERN = /^var\(\s*(--[\w-]+)\s*\)$/;

/** Innermost `selectors { declarations }` blocks; nested at-rule wrappers are skipped. */
const BLOCK_PATTERN = /([^{};]+)\{([^{}]*)\}/g;

/**
 * Reads the custom properties declared directly in the block whose selector
 * list contains `selector` (e.g. `.a.dark` in `.a.dark, .a .dark { ... }`).
 * Throws when no block or more than one block matches, so a typo or a second
 * override block cannot silently escape the contrast checks.
 */
export function readThemeDeclarations(css: string, selector: string): Map<string, string> {
  const source = css.replace(COMMENT_PATTERN, '');
  const bodies = [...source.matchAll(BLOCK_PATTERN)]
    .filter((match) =>
      (match[1] ?? '')
        .split(',')
        .map((part) => part.trim())
        .includes(selector)
    )
    .map((match) => match[2] ?? '');
  if (bodies.length === 0) {
    throw new Error(`Theme block not found: ${selector}`);
  }
  if (bodies.length > 1) {
    throw new Error(`Duplicate theme block: ${selector}`);
  }
  const declarations = new Map<string, string>();
  for (const match of (bodies[0] ?? '').matchAll(DECLARATION_PATTERN)) {
    if (match[1] && match[2]) {
      declarations.set(match[1], match[2].trim());
    }
  }
  return declarations;
}

/** Selectors that apply to the scheme and mode, from lowest to highest precedence. */
function themeCascadeSelectors(scheme: ColorSchemeId, mode: ThemeMode): string[] {
  const selectors = [':root'];
  if (mode === 'dark') {
    selectors.push('.dark');
  }
  if (scheme !== 'factory') {
    selectors.push(`:root[data-color-scheme='${scheme}']`);
    if (mode === 'dark') {
      selectors.push(`:root[data-color-scheme='${scheme}'].dark`);
    }
  }
  return selectors;
}

/** Returns every custom property for the scheme and mode with `var()` references resolved. */
export function resolveThemeVariables(
  css: string,
  scheme: ColorSchemeId,
  mode: ThemeMode
): Map<string, string> {
  const declared = new Map<string, string>();
  for (const selector of themeCascadeSelectors(scheme, mode)) {
    for (const [name, value] of readThemeDeclarations(css, selector)) {
      declared.set(name, value);
    }
  }

  const resolve = (value: string, seen: Set<string>): string => {
    const reference = VAR_PATTERN.exec(value)?.[1];
    if (!reference || seen.has(reference)) {
      return value;
    }
    const target = declared.get(reference);
    return target === undefined ? value : resolve(target, new Set([...seen, reference]));
  };

  const resolved = new Map<string, string>();
  for (const [name, value] of declared) {
    resolved.set(name, resolve(value, new Set([name])));
  }
  return resolved;
}
