// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve('index.html'), 'utf8');

afterEach(() => localStorage.clear());

describe('theme bootstrap before React mounts', () => {
  it('applies the dark fallback to both page and corners when storage is blocked', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const script of doc.querySelectorAll('script:not([src])')) {
      runInNewContext(script.textContent ?? '', {
        document: doc,
        localStorage: {
          getItem() {
            throw new Error('Storage unavailable');
          },
        },
      });
    }
    expect(doc.documentElement.classList.contains('dark')).toBe(true);
    expect(doc.documentElement.style.colorScheme).toBe('dark');
    expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0a0a0a');
  });

  it.each([
    { saved: 'light', systemDark: true, theme: 'light', color: '#fafafa' },
    { saved: 'dark', systemDark: false, theme: 'dark', color: '#0a0a0a' },
    { saved: 'system', systemDark: false, theme: 'light', color: '#fafafa' },
    { saved: 'system', systemDark: true, theme: 'dark', color: '#0a0a0a' },
    { saved: null, systemDark: false, theme: 'dark', color: '#0a0a0a' },
  ])(
    'restores $saved with systemDark=$systemDark on refresh',
    ({ saved, systemDark, theme, color }) => {
      if (saved) {
        localStorage.setItem('theme', saved);
      }
      // A corrupt appearance cache must not prevent the mode from restoring.
      localStorage.setItem('factoryfactory_appearance', '{broken');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const script of doc.querySelectorAll('script:not([src])')) {
        runInNewContext(script.textContent ?? '', {
          document: doc,
          localStorage,
          window: { matchMedia: vi.fn(() => ({ matches: systemDark })) },
        });
      }
      expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(color);
      expect(doc.documentElement.classList.contains(theme)).toBe(true);
      expect(doc.documentElement.style.colorScheme).toBe(theme);
    }
  );
});
