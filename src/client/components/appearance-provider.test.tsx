// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEARANCE_STORAGE_KEY } from '@/client/lib/appearance';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import { AppearanceProvider, useAppearance } from './appearance-provider';

const mocks = vi.hoisted(() => ({
  settings: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    userSettings: { get: { useQuery: () => ({ data: mocks.settings }) } },
  },
}));

let root: Root | null = null;
let seen: ReturnType<typeof useAppearance> | null = null;

function Probe() {
  seen = useAppearance();
  return null;
}

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(createElement(AppearanceProvider, null, createElement(Probe)));
  });
}

beforeEach(() => {
  mocks.settings = undefined;
  seen = null;
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
});

describe('AppearanceProvider', () => {
  it('serves the cached preferences while the settings query is loading', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        colorScheme: 'one',
        styles: { 'font-size': '150%' },
        appearance: { ...DEFAULT_APPEARANCE, colorScheme: 'one', fontScale: 150 },
      })
    );

    render();

    expect(seen).toMatchObject({ colorScheme: 'one', fontScale: 150 });
  });

  it('falls back to the defaults without a usable cache', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ colorScheme: 'one', styles: {} })
    );
    render();
    expect(seen).toEqual(DEFAULT_APPEARANCE);
  });

  it('applies and caches the saved settings once they load', () => {
    mocks.settings = { appearanceColorScheme: 'github', appearanceFontScale: 125 };
    render();

    expect(seen).toMatchObject({ colorScheme: 'github', fontScale: 125 });
    expect(document.documentElement.style.getPropertyValue('font-size')).toBe('125%');
    const cached = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null');
    expect(cached.appearance).toMatchObject({ colorScheme: 'github', fontScale: 125 });
  });
});
