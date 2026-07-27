// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalInstance } from './terminal-instance';

const mocks = vi.hoisted(() => ({
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
  Terminal: vi.fn(function Terminal() {
    return {
      clear: mocks.clear,
      cols: 80,
      dispose: mocks.dispose,
      focus: mocks.focus,
      loadAddon: mocks.loadAddon,
      onData: mocks.onData,
      open: mocks.open,
      rows: 24,
      write: mocks.write,
    };
  }),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe('TerminalInstance', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
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
