// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { LayoutChangedMeta } from 'react-resizable-panels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let capturedDefaultLayout: unknown;
let capturedOnLayoutChanged:
  | ((layout: Record<string, number>, meta: LayoutChangedMeta) => void)
  | undefined;

vi.mock('react-resizable-panels', () => ({
  Group: (props: {
    defaultLayout?: unknown;
    onLayoutChanged?: (layout: Record<string, number>, meta: LayoutChangedMeta) => void;
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

  it('forwards structural changes without overwriting the user preference', () => {
    const stored = JSON.stringify({ left: 60, right: 40 });
    localStorage.setItem('resizable-panels:workspace-3', stored);
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
    const meta = { isUserInteraction: false };
    capturedOnLayoutChanged?.({ left: 100 }, meta);
    expect(onLayoutChanged).toHaveBeenCalledWith({ left: 100 }, meta);
    expect(localStorage.getItem('resizable-panels:workspace-3')).toBe(stored);
    cleanup();
  });

  it('keeps full library-driven commits persistent, including default resets', () => {
    const cleanup = renderInDom((root) => {
      flushSync(() => root.render(createElement(ResizablePanelGroup, { autoSaveId: 'reset' })));
    });
    capturedOnLayoutChanged?.({ left: 60, right: 40 }, { isUserInteraction: true });
    capturedOnLayoutChanged?.({ left: 70, right: 30 }, { isUserInteraction: false });
    expect(localStorage.getItem('resizable-panels:reset')).toBe(
      JSON.stringify({ left: 70, right: 30 })
    );
    cleanup();
  });

  it('persists the requested layout before temporary size constraints', () => {
    const cleanup = renderInDom((root) => {
      flushSync(() =>
        root.render(createElement(ResizablePanelGroup, { autoSaveId: 'constraints' }))
      );
    });
    const requestedLayout = { left: 60, right: 40 };
    capturedOnLayoutChanged?.(
      { left: 50, right: 50 },
      { isUserInteraction: false, requestedLayout }
    );
    expect(localStorage.getItem('resizable-panels:constraints')).toBe(
      JSON.stringify(requestedLayout)
    );
    cleanup();
  });

  it('ignores delayed panel removal after a newer user resize', () => {
    vi.useFakeTimers();
    const cleanup = renderInDom((root) => {
      flushSync(() => root.render(createElement(ResizablePanelGroup, { autoSaveId: 'delayed' })));
    });
    try {
      capturedOnLayoutChanged?.({ left: 60, right: 40 }, { isUserInteraction: true });
      setTimeout(() => capturedOnLayoutChanged?.({ left: 100 }, { isUserInteraction: false }), 100);
      capturedOnLayoutChanged?.({ left: 65, right: 35 }, { isUserInteraction: true });
      vi.advanceTimersByTime(1000);
      expect(localStorage.getItem('resizable-panels:delayed')).toBe(
        JSON.stringify({ left: 65, right: 35 })
      );
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});
