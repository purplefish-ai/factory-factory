// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  getPersistedSidebarWidth,
  parseSidebarWidth,
  persistSidebarWidth,
} from './app-sidebar-resize';

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe('app-sidebar resize helpers', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: createStorageStub(),
    });
    localStorage.clear();
  });

  it('clamps width values to supported range', () => {
    expect(clampSidebarWidth(100)).toBe(240);
    expect(clampSidebarWidth(352.2)).toBe(352);
    expect(clampSidebarWidth(1000)).toBe(640);
  });

  it('parses persisted values and falls back to default for invalid values', () => {
    expect(parseSidebarWidth('480')).toBe(480);
    expect(parseSidebarWidth('999')).toBe(640);
    expect(parseSidebarWidth('not-a-number')).toBe(352);
    expect(parseSidebarWidth(null)).toBe(352);
  });

  it('reads and writes persisted width through localStorage', () => {
    localStorage.setItem('sidebar_width', '500');
    expect(getPersistedSidebarWidth()).toBe(500);

    persistSidebarWidth(999);
    expect(localStorage.getItem('sidebar_width')).toBe('640');
  });
});
