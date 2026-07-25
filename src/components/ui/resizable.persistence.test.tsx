// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let capturedDefaultLayout: unknown;
let capturedOnLayoutChanged:
  | ((layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void)
  | undefined;

vi.mock('react-resizable-panels', () => ({
  Group: (props: {
    defaultLayout?: unknown;
    onLayoutChanged?: (
      layout: Record<string, number>,
      meta: { isUserInteraction: boolean }
    ) => void;
    children?: ReactNode;
  }) => {
    capturedDefaultLayout = props.defaultLayout;
    capturedOnLayoutChanged = props.onLayoutChanged;
    return createElement('div', null, props.children);
  },
  Panel: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  Separator: (props: { children?: ReactNode }) => createElement('div', null, props.children),
}));

vi.mock('@phosphor-icons/react', () => ({
  DotsSixVerticalIcon: () => createElement('svg'),
}));

import { ResizablePanelGroup } from './resizable';

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

function renderInDom(render: (root: Root) => void): () => void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  render(root);
  return () => {
    root.unmount();
    container.remove();
  };
}

beforeEach(() => {
  capturedDefaultLayout = undefined;
  capturedOnLayoutChanged = undefined;
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

describe('ResizablePanelGroup persistence', () => {
  it('loads stored array layouts from localStorage', () => {
    localStorage.setItem('resizable-panels:workspace-1', JSON.stringify([30, 70]));

    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(ResizablePanelGroup, {
            autoSaveId: 'workspace-1',
            defaultLayout: { left: 50, right: 50 },
          })
        );
      });
    });

    expect(capturedDefaultLayout).toEqual([30, 70]);
    cleanup();
  });

  it('falls back to default layout when persisted layout is invalid', () => {
    localStorage.setItem(
      'resizable-panels:workspace-2',
      JSON.stringify({ left: 25, right: 'invalid' })
    );

    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(ResizablePanelGroup, {
            autoSaveId: 'workspace-2',
            defaultLayout: { left: 40, right: 60 },
          })
        );
      });
    });

    expect(capturedDefaultLayout).toEqual({ left: 40, right: 60 });
    cleanup();
  });

  it('persists completed layouts and forwards their interaction metadata', () => {
    const onLayoutChanged = vi.fn();
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(ResizablePanelGroup, {
            autoSaveId: 'workspace-3',
            onLayoutChanged,
          })
        );
      });
    });
    const layout = { left: 35, right: 65 };
    const meta = { isUserInteraction: true };

    capturedOnLayoutChanged?.(layout, meta);

    expect(onLayoutChanged).toHaveBeenCalledWith(layout, meta);
    expect(localStorage.getItem('resizable-panels:workspace-3')).toBe(JSON.stringify(layout));
    cleanup();
  });
});
