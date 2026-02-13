// @vitest-environment jsdom

// Mock Prisma client to avoid node: module imports in jsdom - must be before imports
import { vi } from 'vitest';

vi.mock('@factory-factory/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    SessionStatus: {
      IDLE: 'IDLE',
      RUNNING: 'RUNNING',
      ERROR: 'ERROR',
      STOPPED: 'STOPPED',
    },
  };
});

import { SessionStatus } from '@factory-factory/core';
import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandInfo } from '@/lib/chat-protocol';
import { type SessionData, SessionTabBar } from './session-tab-bar';
import { SlashCommandPalette, type SlashCommandPaletteHandle } from './slash-command-palette';

function makeSession(id: string, createdAt: string): SessionData {
  return {
    id,
    status: SessionStatus.IDLE,
    name: null,
    createdAt: new Date(createdAt),
  };
}

function defineReadonlyLayout(
  element: HTMLElement,
  values: { scrollLeft: number; clientWidth: number; scrollWidth: number }
): void {
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    writable: true,
    value: values.scrollLeft,
  });
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: values.clientWidth,
  });
  Object.defineProperty(element, 'scrollWidth', {
    configurable: true,
    value: values.scrollWidth,
  });
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

afterEach(() => {
  document.body.innerHTML = '';
});

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverMock {
    observe() {
      // no-op for jsdom
    }
    unobserve() {
      // no-op for jsdom
    }
    disconnect() {
      // no-op for jsdom
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
}

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  writable: true,
  value: () => {
    // no-op for jsdom
  },
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

describe('session-tab-bar regression coverage', () => {
  it('recomputes overflow arrows when session count changes', () => {
    const cleanup = renderInDom((root, container) => {
      const onSelectSession = vi.fn();
      const onCreateSession = vi.fn();
      const onCloseSession = vi.fn();

      flushSync(() => {
        root.render(
          createElement(SessionTabBar, {
            sessions: [makeSession('s1', '2026-01-01T00:00:00Z')],
            currentSessionId: 's1',
            onSelectSession,
            onCreateSession,
            onCloseSession,
          })
        );
      });

      const tablist = container.querySelector('[role="tablist"]');
      expect(tablist).not.toBeNull();
      defineReadonlyLayout(tablist as HTMLElement, {
        scrollLeft: 0,
        clientWidth: 100,
        scrollWidth: 100,
      });

      flushSync(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(container.querySelector('.lucide-chevron-right')).toBeNull();

      defineReadonlyLayout(tablist as HTMLElement, {
        scrollLeft: 0,
        clientWidth: 100,
        scrollWidth: 300,
      });
      flushSync(() => {
        root.render(
          createElement(SessionTabBar, {
            sessions: [
              makeSession('s1', '2026-01-01T00:00:00Z'),
              makeSession('s2', '2026-01-01T00:02:00Z'),
              makeSession('s3', '2026-01-01T00:03:00Z'),
            ],
            currentSessionId: 's1',
            onSelectSession,
            onCreateSession,
            onCloseSession,
          })
        );
      });

      expect(container.querySelector('.lucide-chevron-right')).not.toBeNull();
    });

    cleanup();
  });
});

describe('slash-command-palette regression coverage', () => {
  it('resets selected command when filter changes even if result count stays the same', () => {
    const commands: CommandInfo[] = [
      { name: 'alpha', description: 'First' },
      { name: 'beta', description: 'Second' },
      { name: 'gamma', description: 'Third' },
    ];

    const onSelect = vi.fn();
    const onClose = vi.fn();
    const anchorEl = document.createElement('div');
    document.body.appendChild(anchorEl);
    const anchorRef = { current: anchorEl };
    const paletteRef = createRef<SlashCommandPaletteHandle>();

    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(SlashCommandPalette, {
            commands,
            isOpen: true,
            onClose,
            onSelect,
            filter: '',
            anchorRef,
            paletteRef,
          })
        );
      });

      // Move selection from index 0 -> 2
      flushSync(() => {
        expect(paletteRef.current?.handleKeyDown('ArrowDown')).toBe('handled');
        expect(paletteRef.current?.handleKeyDown('ArrowDown')).toBe('handled');
      });

      // Filter changes but still returns all 3 commands.
      flushSync(() => {
        root.render(
          createElement(SlashCommandPalette, {
            commands,
            isOpen: true,
            onClose,
            onSelect,
            filter: 'a',
            anchorRef,
            paletteRef,
          })
        );
      });

      flushSync(() => {
        expect(paletteRef.current?.handleKeyDown('Enter')).toBe('handled');
      });

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(commands[0]);
    });

    cleanup();
  });
});
