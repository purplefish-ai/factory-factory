/**
 * Applies appearance preferences to the document.
 *
 * Everything is expressed as a color-scheme attribute plus inline custom
 * properties on <html>, so the same resolved form can be cached in
 * localStorage and replayed by the bootstrap script in index.html before
 * React mounts. That keeps a reload from flashing the default font size.
 */

import { z } from 'zod';
import type { AppearanceSettings } from '@/shared/appearance';
import { DEFAULT_FONT_SCALE } from '@/shared/appearance';

export const APPEARANCE_STORAGE_KEY = 'factoryfactory_appearance';
export const COLOR_SCHEME_ATTRIBUTE = 'data-color-scheme';

/** Every property applyAppearance may write, so stale ones can be cleared. */
export const APPEARANCE_STYLE_PROPERTIES = [
  'font-size',
  '--font-sans',
  '--font-mono',
  '--background',
  '--card',
  '--popover',
  '--sidebar',
  '--foreground',
  '--card-foreground',
  '--popover-foreground',
  '--sidebar-foreground',
  '--muted-foreground',
] as const;

export interface ResolvedAppearance {
  colorScheme: string;
  styles: Record<string, string>;
}

const resolvedAppearanceSchema = z.object({
  colorScheme: z.string(),
  styles: z.record(z.string(), z.string()),
});

function applyColorOverrides(appearance: AppearanceSettings, styles: Record<string, string>) {
  const { backgroundColor, foregroundColor } = appearance;
  if (backgroundColor) {
    styles['--background'] = backgroundColor;
    styles['--sidebar'] = backgroundColor;
    // Cards and popovers sit slightly above the page in both light and dark
    // mode, so nudge the override toward white rather than reusing it flat.
    const raised = `color-mix(in oklab, ${backgroundColor} 94%, white 6%)`;
    styles['--card'] = raised;
    styles['--popover'] = raised;
  }
  if (foregroundColor) {
    styles['--foreground'] = foregroundColor;
    styles['--card-foreground'] = foregroundColor;
    styles['--popover-foreground'] = foregroundColor;
    styles['--sidebar-foreground'] = foregroundColor;
    // Secondary text follows the override instead of staying a preset gray
    // that may be unreadable against a custom background.
    styles['--muted-foreground'] =
      `color-mix(in oklab, ${foregroundColor} 70%, var(--background) 30%)`;
  }
}

/** Pure mapping from preferences to the attribute and style properties to set. */
export function resolveAppearanceStyles(appearance: AppearanceSettings): ResolvedAppearance {
  const styles: Record<string, string> = {};
  if (appearance.fontScale !== DEFAULT_FONT_SCALE) {
    styles['font-size'] = `${appearance.fontScale}%`;
  }
  if (appearance.fontSans) {
    styles['--font-sans'] = appearance.fontSans;
  }
  if (appearance.fontMono) {
    styles['--font-mono'] = appearance.fontMono;
  }
  applyColorOverrides(appearance, styles);
  return { colorScheme: appearance.colorScheme, styles };
}

export function applyResolvedAppearance(resolved: ResolvedAppearance, root: HTMLElement): void {
  root.setAttribute(COLOR_SCHEME_ATTRIBUTE, resolved.colorScheme);
  for (const property of APPEARANCE_STYLE_PROPERTIES) {
    const value = resolved.styles[property];
    if (value === undefined) {
      root.style.removeProperty(property);
    } else {
      root.style.setProperty(property, value);
    }
  }
}

export function applyAppearance(
  appearance: AppearanceSettings,
  root: HTMLElement = document.documentElement
): ResolvedAppearance {
  const resolved = resolveAppearanceStyles(appearance);
  applyResolvedAppearance(resolved, root);
  return resolved;
}

export function writeStoredAppearance(
  resolved: ResolvedAppearance,
  storage: Pick<Storage, 'setItem'> = localStorage
): void {
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(resolved));
  } catch {
    // Non-blocking: the preferences still apply, the next load just flashes briefly.
  }
}

export function readStoredAppearance(
  storage: Pick<Storage, 'getItem'> = localStorage
): ResolvedAppearance | null {
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = resolvedAppearanceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
