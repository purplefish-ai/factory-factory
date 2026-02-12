// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider, useSidebar } from './sidebar';

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

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

function SidebarProbe() {
  const { state, open, setOpen } = useSidebar();
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="open">{String(open)}</span>
      <button type="button" onClick={() => setOpen(false)}>
        collapse
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        expand
      </button>
    </div>
  );
}

function renderInDom(render: (root: Root, container: HTMLDivElement) => void): () => void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  render(root, container);
  return () => {
    root.unmount();
    container.remove();
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: createStorageStub(),
  });
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SidebarProvider persistence', () => {
  it('initializes from localStorage when persisted state exists', () => {
    localStorage.setItem('sidebar_state', 'false');

    const cleanup = renderInDom((root, container) => {
      flushSync(() => {
        root.render(createElement(SidebarProvider, null, createElement(SidebarProbe)));
      });

      const state = container.querySelector('[data-testid="state"]');
      const open = container.querySelector('[data-testid="open"]');
      expect(state?.textContent).toBe('collapsed');
      expect(open?.textContent).toBe('false');
    });

    cleanup();
  });

  it('writes localStorage when open state changes', () => {
    const cleanup = renderInDom((root, container) => {
      flushSync(() => {
        root.render(createElement(SidebarProvider, null, createElement(SidebarProbe)));
      });

      const collapseButton = container.querySelector('button');
      expect(collapseButton).not.toBeNull();
      flushSync(() => {
        collapseButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(localStorage.getItem('sidebar_state')).toBe('false');
    });

    cleanup();
  });
});
