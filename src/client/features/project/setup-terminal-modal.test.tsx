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
  authenticate: vi.fn(),
  authenticatingProvider: null,
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

vi.mock('@/client/components/terminal-instance', () => ({
  TerminalInstance: () => null,
}));

describe('SetupTerminalModal', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function render() {
    await act(async () => {
      root.render(createElement(SetupTerminalModal, { open: true, onClose: vi.fn() }));
      await Promise.resolve();
    });
  }

  function findRetryButton(): HTMLButtonElement | null {
    return [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry') ?? null;
  }

  beforeEach(() => {
    setupTerminalState.authenticatingProvider = null;
    setupTerminalState.connected = false;
    setupTerminalState.gaveUp = false;
    setupTerminalState.showTerminal = false;
    setupTerminalState.reconnect = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('offers bundled provider login without requiring a separate global CLI', async () => {
    await render();
    expect(document.body.textContent).toContain('ff codex login');
    expect(document.body.textContent).toContain('ff claude auth login');
    expect(document.body.textContent).toContain('require the ff CLI to be installed');
  });

  it('launches managed Claude login from a desktop-safe button', async () => {
    setupTerminalState.connected = true;
    await render();
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sign in to Claude'
    );
    expect(button).toBeDefined();
    void act(() => button?.click());
    expect(setupTerminalState.authenticate).toHaveBeenCalledWith('CLAUDE');
  });

  it('disables both sign-in actions while a login is active', async () => {
    setupTerminalState.connected = true;
    setupTerminalState.authenticatingProvider = 'CLAUDE';
    await render();
    const actions = [...document.querySelectorAll('button')].filter((button) =>
      /Sign in to (Claude|Codex)/.test(button.textContent ?? '')
    );
    expect(actions).toHaveLength(2);
    expect(actions.every((button) => button.disabled)).toBe(true);
  });

  it('shows a Retry control when the connection gives up before ever connecting', async () => {
    setupTerminalState.gaveUp = true;
    await render();

    const retry = findRetryButton();
    expect(retry).not.toBeNull();
    expect(document.body.textContent).toContain('Connection failed.');

    void act(() => {
      retry?.click();
    });
    expect(setupTerminalState.reconnect).toHaveBeenCalledTimes(1);
  });

  it('says the connection was lost when an established terminal gives up', async () => {
    setupTerminalState.gaveUp = true;
    setupTerminalState.showTerminal = true;
    await render();

    expect(document.body.textContent).toContain('Connection lost.');
    expect(findRetryButton()).not.toBeNull();
  });

  it('shows the reconnecting status while a previous session reconnects', async () => {
    setupTerminalState.showTerminal = true;
    await render();

    expect(document.body.textContent).toContain('Reconnecting');
    expect(findRetryButton()).toBeNull();
  });

  it('shows no status overlay while connected or during the initial connect', async () => {
    await render();
    expect(document.body.textContent).not.toContain('Reconnecting');
    expect(findRetryButton()).toBeNull();

    setupTerminalState.connected = true;
    setupTerminalState.showTerminal = true;
    await render();
    expect(document.body.textContent).not.toContain('Reconnecting');
  });
});
