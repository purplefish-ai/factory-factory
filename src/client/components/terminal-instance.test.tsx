// @vitest-environment jsdom

import { Terminal } from '@xterm/xterm';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import { TerminalInstance } from './terminal-instance';

const mocks = vi.hoisted(() => ({
  appearance: {
    colorScheme: 'factory',
    backgroundColor: null as string | null,
    foregroundColor: null as string | null,
    fontScale: 100,
    fontSans: null as string | null,
    fontMono: null as string | null,
  },
  fit: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  focus: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddon() {
    return {
      fit: mocks.fit,
    };
  }),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function Terminal(options: Record<string, unknown>) {
    return {
      clear: mocks.clear,
      cols: 80,
      dispose: mocks.dispose,
      focus: mocks.focus,
      loadAddon: mocks.loadAddon,
      onData: mocks.onData,
      open: mocks.open,
      options: { ...options },
      rows: 24,
      write: mocks.write,
    };
  }),
}));

vi.mock('@/client/components/appearance-provider', () => ({
  useAppearance: () => mocks.appearance,
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe('TerminalInstance', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    Object.assign(mocks.appearance, DEFAULT_APPEARANCE);
    vi.mocked(Terminal).mockClear();
    mocks.fit.mockReset();
    mocks.clear.mockReset();
    mocks.dispose.mockReset();
    mocks.focus.mockReset();
    mocks.loadAddon.mockReset();
    mocks.onData.mockReset();
    mocks.open.mockReset();
    mocks.write.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('waits for an explicit tap before focusing on touch screens, including after activation', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = { onData: vi.fn(), onResize: vi.fn(), output: '' };
    flushSync(() => root.render(createElement(TerminalInstance, { ...props, isActive: false })));
    flushSync(() => root.render(createElement(TerminalInstance, { ...props, isActive: true })));
    expect(mocks.focus).not.toHaveBeenCalled();
    container.querySelector<HTMLElement>('[role="application"]')?.click();
    expect(mocks.focus).toHaveBeenCalledOnce();
    root.unmount();
  });

  it('uses the default terminal font when appearance is default', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(TerminalInstance, { onData: vi.fn(), onResize: vi.fn(), output: '' })
      );
    });

    expect(vi.mocked(Terminal).mock.calls[0]?.[0]).toMatchObject({
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    });

    root.unmount();
  });

  it('scales the font and applies the monospace font from appearance settings', () => {
    mocks.appearance.fontScale = 150;
    mocks.appearance.fontMono = '"Fira Code", monospace';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onResize = vi.fn();

    flushSync(() => {
      root.render(createElement(TerminalInstance, { onData: vi.fn(), onResize, output: '' }));
    });

    expect(vi.mocked(Terminal).mock.calls[0]?.[0]).toMatchObject({
      fontSize: 20,
      fontFamily: '"Fira Code", monospace',
    });
    // Mount reports size once; the font effect must not refit when nothing changed.
    expect(mocks.fit).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledTimes(1);

    mocks.appearance.fontScale = 100;
    flushSync(() => {
      root.render(createElement(TerminalInstance, { onData: vi.fn(), onResize, output: '' }));
    });

    const instance = vi.mocked(Terminal).mock.results[0]?.value as {
      options: Record<string, unknown>;
    };
    expect(instance.options.fontSize).toBe(13);
    expect(instance.options.fontFamily).toBe('"Fira Code", monospace');
    expect(mocks.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenCalledTimes(2);

    root.unmount();
  });

  it('appends only the new suffix when output grows', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(TerminalInstance, {
          onData: vi.fn(),
          onResize: vi.fn(),
          output: 'abc',
        })
      );
    });

    flushSync(() => {
      root.render(
        createElement(TerminalInstance, {
          onData: vi.fn(),
          onResize: vi.fn(),
          output: 'abcdef',
        })
      );
    });

    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.write.mock.calls).toEqual([['abc'], ['def']]);

    root.unmount();
  });

  it('repaints when rolling output is rewritten without growing', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(TerminalInstance, {
          onData: vi.fn(),
          onResize: vi.fn(),
          output: '[cut]\nklmnop',
        })
      );
    });

    flushSync(() => {
      root.render(
        createElement(TerminalInstance, {
          onData: vi.fn(),
          onResize: vi.fn(),
          output: '[cut]\nopqrst',
        })
      );
    });

    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.write.mock.calls).toEqual([['[cut]\nklmnop'], ['[cut]\nopqrst']]);

    root.unmount();
  });
});
