// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupTerminalModal } from './setup-terminal-modal';
import type { UseSetupTerminalResult } from './use-setup-terminal';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const setupTerminalState: UseSetupTerminalResult = {
  connected: false,
  gaveUp: false,
  reconnect: vi.fn(),
  showTerminal: false,
  output: '',
  handleData: vi.fn(),
  handleResize: vi.fn(),
};

vi.mock('./use-setup-terminal', () => ({
  useSetupTerminal: () => ({ ...setupTerminalState }),
}));

vi.mock('@/components/workspace/terminal-instance', () => ({
  TerminalInstance: () => null,
}));

describe('SetupTerminalModal', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function render() {
    void act(() => {
      root.render(createElement(SetupTerminalModal, { open: true, onClose: vi.fn() }));
    });
  }

  function findRetryButton(): HTMLButtonElement | null {
    return [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry') ?? null;
  }

  beforeEach(() => {
    setupTerminalState.connected = false;
    setupTerminalState.gaveUp = false;
    setupTerminalState.showTerminal = false;
    setupTerminalState.reconnect = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  it('shows a Retry control when the connection gives up before ever connecting', () => {
    setupTerminalState.gaveUp = true;
    render();

    const retry = findRetryButton();
    expect(retry).not.toBeNull();

    void act(() => {
      retry?.click();
    });
    expect(setupTerminalState.reconnect).toHaveBeenCalledTimes(1);
  });

  it('shows the reconnecting status while a previous session reconnects', () => {
    setupTerminalState.showTerminal = true;
    render();

    expect(document.body.textContent).toContain('Reconnecting');
    expect(findRetryButton()).toBeNull();
  });

  it('shows no status overlay while connected or during the initial connect', () => {
    render();
    expect(document.body.textContent).not.toContain('Reconnecting');
    expect(findRetryButton()).toBeNull();

    setupTerminalState.connected = true;
    setupTerminalState.showTerminal = true;
    render();
    expect(document.body.textContent).not.toContain('Reconnecting');
  });
});
