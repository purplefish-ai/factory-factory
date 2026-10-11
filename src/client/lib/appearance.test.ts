// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  COLOR_SCHEME_ATTRIBUTE,
  readStoredAppearance,
  resolveAppearanceStyles,
  writeStoredAppearance,
} from './appearance';

describe('resolveAppearanceStyles', () => {
  it('sets nothing but the scheme for the default appearance', () => {
    expect(resolveAppearanceStyles(DEFAULT_APPEARANCE)).toEqual({
      colorScheme: 'factory',
      styles: {},
      appearance: DEFAULT_APPEARANCE,
    });
  });

  it('maps each preference to the properties it controls', () => {
    const resolved = resolveAppearanceStyles({
      colorScheme: 'github',
      backgroundColor: '#101010',
      foregroundColor: '#ffff00',
      fontScale: 125,
      fontSans: 'Inter',
      fontMono: '"Fira Code", monospace',
    });
    expect(resolved.colorScheme).toBe('github');
    expect(resolved.styles).toMatchObject({
      'font-size': '125%',
      '--font-sans': 'Inter',
      '--font-mono': '"Fira Code", monospace',
      '--background': '#101010',
      '--sidebar': '#101010',
      '--foreground': '#ffff00',
      '--card-foreground': '#ffff00',
    });
    expect(resolved.styles['--card']).toContain('#101010');
    expect(resolved.styles['--muted-foreground']).toContain('#ffff00');
  });
});

describe('applyAppearance', () => {
  it('writes and then clears properties on the root element', () => {
    const root = document.createElement('html');
    applyAppearance({ ...DEFAULT_APPEARANCE, fontScale: 150, backgroundColor: '#000000' }, root);
    expect(root.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe('factory');
    expect(root.style.getPropertyValue('font-size')).toBe('150%');
    expect(root.style.getPropertyValue('--background')).toBe('#000000');

    applyAppearance({ ...DEFAULT_APPEARANCE, colorScheme: 'solarized' }, root);
    expect(root.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe('solarized');
    expect(root.style.getPropertyValue('font-size')).toBe('');
    expect(root.style.getPropertyValue('--background')).toBe('');
  });
});

describe('stored appearance', () => {
  it('round-trips the resolved form through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const appearance = { ...DEFAULT_APPEARANCE, colorScheme: 'one' as const, fontScale: 110 };
    const resolved = { colorScheme: 'one', styles: { 'font-size': '110%' }, appearance };
    writeStoredAppearance(resolved, storage);
    expect(store.has(APPEARANCE_STORAGE_KEY)).toBe(true);
    expect(readStoredAppearance(storage)).toEqual(resolved);
  });

  it('ignores missing, malformed, or mistyped stored values', () => {
    expect(readStoredAppearance({ getItem: () => null })).toBeNull();
    expect(readStoredAppearance({ getItem: () => '{not json' })).toBeNull();
    expect(readStoredAppearance({ getItem: () => JSON.stringify({ styles: 'nope' }) })).toBeNull();
    // Entries written before the preferences were cached alongside the styles.
    expect(
      readStoredAppearance({ getItem: () => JSON.stringify({ colorScheme: 'one', styles: {} }) })
    ).toBeNull();
    expect(
      readStoredAppearance({
        getItem: () => {
          throw new Error('blocked');
        },
      })
    ).toBeNull();
  });

  it('survives storage that throws on access', () => {
    const blocked = Object.create(null, {
      localStorage: {
        get() {
          throw new Error('SecurityError');
        },
      },
    });
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => blocked.localStorage,
    });
    try {
      expect(() =>
        writeStoredAppearance({ colorScheme: 'one', styles: {}, appearance: DEFAULT_APPEARANCE })
      ).not.toThrow();
      expect(readStoredAppearance()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
