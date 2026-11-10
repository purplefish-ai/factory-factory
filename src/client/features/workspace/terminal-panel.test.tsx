// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_OUTPUT_MAX_CHARS, TERMINAL_TRUNCATION_MARKER } from '@/client/lib/rolling-output';
import type { TerminalOutputStream } from '@/client/lib/terminal-output-stream';
import { TerminalPanel } from './terminal-panel';
import { type TerminalTabs, useTerminalTabs } from './use-terminal-tabs';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  destroy: vi.fn(),
  setActive: vi.fn(),
  reconnect: vi.fn(),
  connected: true,
  gaveUp: false,
  renderedStream: null as TerminalOutputStream | null,
  terminalRenders: 0,
  requestedFocus: false,
  options: null as {
    onCreated?: (terminalId: string, requestId?: string, outputBuffer?: string) => void;
    onOutput?: (terminalId: string, data: string) => void;
    onExit?: (terminalId: string, exitCode: number) => void;
    onError?: (message: string, requestId?: string) => void;
    onTerminalList?: (
      terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>
    ) => void;
  } | null,
}));

vi.mock('@phosphor-icons/react/dist/csr/Terminal', () => ({ TerminalIcon: () => null }));

vi.mock('@/client/components/terminal-instance', () => ({
  TerminalInstance: ({
    output,
    isActive,
  }: {
    output: TerminalOutputStream;
    isActive?: boolean;
  }) => {
    mocks.requestedFocus = Boolean(isActive);
    mocks.renderedStream = output;
    mocks.terminalRenders += 1;
    return null;
  },
}));

vi.mock('./terminal-tab-bar', () => ({
  TerminalTabBar: () => null,
}));

vi.mock('./use-terminal-websocket', () => ({
  useTerminalWebSocket: (options: typeof mocks.options) => {
    mocks.options = options;
    return {
      connected: mocks.connected,
      gaveUp: mocks.gaveUp,
      create: mocks.create,
      sendInput: mocks.sendInput,
      resize: mocks.resize,
      destroy: mocks.destroy,
      setActive: mocks.setActive,
      reconnect: mocks.reconnect,
    };
  },
}));

/** Owns the tabs and renders the controlled panel, as the right panel does. */
function TerminalPanelHarness({
  workspaceId,
  autoCreateWhenEmpty = false,
  isVisible = true,
  onStateChange,
}: {
  workspaceId: string;
  autoCreateWhenEmpty?: boolean;
  isVisible?: boolean;
  onStateChange?: (state: TerminalTabs) => void;
}) {
  const terminal = useTerminalTabs({ workspaceId, autoCreate: autoCreateWhenEmpty && isVisible });
  onStateChange?.(terminal);
  return createElement(TerminalPanel, { terminal, isVisible, autoCreateWhenEmpty });
}

/** Records each render's tabs so a test can drive them like the tab bar does. */
function trackPanel(onState?: (state: TerminalTabs) => void) {
  let latest: TerminalTabs | undefined;
  return {
    onStateChange: (state: TerminalTabs) => {
      latest = state;
      onState?.(state);
    },
    newTab: () => latest?.newTab(),
  };
}

/** Output the mounted terminal would show: its stream's rolling window. */
function renderedOutput(): string {
  return mocks.renderedStream?.snapshot() ?? '';
}

describe('TerminalPanel', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.sendInput.mockReset();
    mocks.resize.mockReset();
    mocks.destroy.mockReset();
    mocks.setActive.mockReset();
    mocks.reconnect.mockReset();
    mocks.connected = true;
    mocks.gaveUp = false;
    mocks.renderedStream = null;
    mocks.terminalRenders = 0;
    mocks.requestedFocus = false;
    mocks.options = null;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('auto-creates a workspace terminal without requesting keyboard focus', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      flushSync(() =>
        root.render(
          createElement(TerminalPanelHarness, {
            workspaceId: 'new-workspace',
            autoCreateWhenEmpty: true,
          })
        )
      );
      flushSync(() => mocks.options?.onTerminalList?.([]));
      await vi.dynamicImportSettled();
      await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
      flushSync(() =>
        mocks.options?.onCreated?.('terminal-new', mocks.create.mock.calls[0]?.[0], '$ ready')
      );
      await vi.waitFor(() => expect(renderedOutput()).toBe('$ ready'));
      expect(mocks.requestedFocus).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('waits for the terminal list after a reconnect before auto-creating', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const states: TerminalTabs[] = [];
    const panel = trackPanel((state) => states.push(state));
    const render = () =>
      flushSync(() =>
        root.render(
          createElement(TerminalPanelHarness, {
            workspaceId: 'workspace-1',
            autoCreateWhenEmpty: true,
            onStateChange: panel.onStateChange,
          })
        )
      );
    try {
      render();
      flushSync(() =>
        mocks.options?.onTerminalList?.([
          { id: 'terminal-existing', createdAt: '2026-08-13T00:00:00.000Z' },
        ])
      );
      mocks.connected = false;
      render();
      flushSync(() => states.at(-1)?.closeTab('tab-terminal-existing'));
      await vi.waitFor(() => expect(states.at(-1)?.tabs).toEqual([]));

      mocks.connected = true;
      render();
      expect(mocks.create).not.toHaveBeenCalled();

      flushSync(() => mocks.options?.onTerminalList?.([]));
      expect(mocks.create).toHaveBeenCalledOnce();
    } finally {
      root.unmount();
    }
  });

  it('ignores disconnected create requests without blocking terminal restoration', () => {
    mocks.connected = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const terminalStates: TerminalTabs[] = [];
    const panel = trackPanel((state) => {
      terminalStates.push(state);
    });

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });

    flushSync(() => {
      panel.newTab();
    });

    expect(mocks.create).not.toHaveBeenCalled();
    expect(terminalStates.at(-1)?.tabs).toEqual([]);

    flushSync(() => {
      mocks.options?.onTerminalList?.([
        { id: 'terminal-existing', createdAt: '2026-08-13T00:00:00.000Z' },
      ]);
    });

    expect(terminalStates.at(-1)?.tabs).toEqual([
      { id: 'tab-terminal-existing', label: 'Terminal 1', terminalId: 'terminal-existing' },
    ]);

    root.unmount();
  });

  it('replays reconnect buffers for existing tabs without changing their identity or selection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const states: TerminalTabs[] = [];
    const panel = trackPanel((state) => states.push(state));
    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });
    flushSync(() => {
      panel.newTab();
      panel.newTab();
    });
    flushSync(() => {
      mocks.options?.onCreated?.('terminal-a', mocks.create.mock.calls[0]?.[0], 'before A\r\n');
      mocks.options?.onCreated?.('terminal-b', mocks.create.mock.calls[1]?.[0], 'before B\r\n');
    });
    await vi.dynamicImportSettled();
    const before = states.at(-1);

    flushSync(() => {
      mocks.options?.onTerminalList?.([
        {
          id: 'terminal-a',
          createdAt: '2026-08-13T00:00:00.000Z',
          outputBuffer: 'before A\r\nmissed A\r\n',
        },
        {
          id: 'terminal-b',
          createdAt: '2026-08-13T00:00:00.000Z',
          outputBuffer: 'before B\r\nmissed B\r\n',
        },
      ]);
    });
    expect(renderedOutput()).toBe('before B\r\nmissed B\r\n');
    expect(states.at(-1)?.tabs).toEqual(before?.tabs);
    expect(states.at(-1)?.activeTabId).toBe(before?.activeTabId);

    flushSync(() => states.at(-1)?.selectTab(before?.tabs[0]?.id ?? ''));
    expect(renderedOutput()).toBe('before A\r\nmissed A\r\n');
    flushSync(() => mocks.options?.onOutput?.('terminal-a', 'live A\r\n'));
    expect(renderedOutput()).toBe('before A\r\nmissed A\r\nlive A\r\n');
    root.unmount();
  });

  it('keeps the server active terminal aligned with the selected pending tab', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });

    flushSync(() => {
      panel.newTab();
      panel.newTab();
    });

    const firstRequestId = mocks.create.mock.calls[0]?.[0] as string;
    const secondRequestId = mocks.create.mock.calls[1]?.[0] as string;

    flushSync(() => {
      mocks.options?.onCreated?.('terminal-a', firstRequestId);
    });

    expect(mocks.setActive).not.toHaveBeenCalled();

    flushSync(() => {
      mocks.options?.onCreated?.('terminal-b', secondRequestId);
    });

    expect(mocks.setActive).toHaveBeenCalledTimes(1);
    expect(mocks.setActive).toHaveBeenCalledWith('terminal-b');

    root.unmount();
  });

  it('does not consume a pending tab when an uncorrelated error arrives', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });

    flushSync(() => {
      panel.newTab();
    });

    const requestId = mocks.create.mock.calls[0]?.[0] as string;

    flushSync(() => {
      mocks.options?.onError?.('unscoped failure');
      mocks.options?.onCreated?.('terminal-a', requestId);
    });

    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.setActive).toHaveBeenCalledTimes(1);
    expect(mocks.setActive).toHaveBeenCalledWith('terminal-a');

    root.unmount();
  });

  it('shows a disconnected notice while the transport is reconnecting', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });
    flushSync(() => {
      panel.newTab();
    });
    const requestId = mocks.create.mock.calls[0]?.[0] as string;
    flushSync(() => {
      mocks.options?.onCreated?.('terminal-a', requestId);
    });

    mocks.connected = false;
    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });
    await vi.dynamicImportSettled();

    expect(container.textContent).toContain('disconnected');
    // The manual Reconnect button must only appear once the transport gave up.
    expect(container.textContent).not.toContain('Reconnect');

    root.unmount();
  });

  it('offers a manual reconnect once the transport gives up', async () => {
    mocks.connected = false;
    mocks.gaveUp = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(TerminalPanelHarness, { workspaceId: 'workspace-1' }));
    });
    await vi.dynamicImportSettled();

    const reconnectButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Reconnect')
    );
    expect(reconnectButton).toBeDefined();

    flushSync(() => {
      reconnectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.reconnect).toHaveBeenCalledTimes(1);

    root.unmount();
  });

  it('hides the disconnected notice while connected', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });
    flushSync(() => {
      panel.newTab();
    });
    await vi.dynamicImportSettled();

    expect(container.textContent).not.toContain('disconnected');

    root.unmount();
  });

  it('bounds live terminal output for associated tabs', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });

    flushSync(() => {
      panel.newTab();
    });

    const requestId = mocks.create.mock.calls[0]?.[0] as string;

    flushSync(() => {
      mocks.options?.onCreated?.('terminal-a', requestId);
      mocks.options?.onOutput?.('terminal-a', 'a'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 100));
    });
    await vi.dynamicImportSettled();

    expect(renderedOutput().length).toBe(TERMINAL_OUTPUT_MAX_CHARS);
    expect(renderedOutput().startsWith(TERMINAL_TRUNCATION_MARKER)).toBe(true);
    expect(renderedOutput().endsWith('a'.repeat(100))).toBe(true);

    root.unmount();
  });

  it('renders the created output buffer before client-buffered output', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });

    flushSync(() => {
      panel.newTab();
    });

    const requestId = mocks.create.mock.calls[0]?.[0] as string;

    flushSync(() => {
      mocks.options?.onOutput?.('terminal-a', 'live output');
      mocks.options?.onCreated?.('terminal-a', requestId, 'early prompt $ ');
    });
    await vi.dynamicImportSettled();

    expect(renderedOutput()).toBe('early prompt $ live output');

    root.unmount();
  });

  it('bounds pending terminal output before a tab is associated', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });

    flushSync(() => {
      panel.newTab();
    });

    const requestId = mocks.create.mock.calls[0]?.[0] as string;

    flushSync(() => {
      mocks.options?.onOutput?.('terminal-a', 'b'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 100));
      mocks.options?.onCreated?.('terminal-a', requestId);
    });
    await vi.dynamicImportSettled();

    expect(renderedOutput().length).toBe(TERMINAL_OUTPUT_MAX_CHARS);
    expect(renderedOutput().startsWith(TERMINAL_TRUNCATION_MARKER)).toBe(true);
    expect(renderedOutput().endsWith('b'.repeat(100))).toBe(true);

    root.unmount();
  });

  it('appends live output without re-rendering the panel or its owner', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onStateChange = vi.fn();
    const panel = trackPanel(onStateChange);

    flushSync(() => {
      root.render(
        createElement(TerminalPanelHarness, {
          workspaceId: 'workspace-1',
          onStateChange: panel.onStateChange,
        })
      );
    });
    flushSync(() => {
      panel.newTab();
    });
    flushSync(() => {
      mocks.options?.onCreated?.('terminal-a', mocks.create.mock.calls[0]?.[0], '$ ');
    });
    await vi.dynamicImportSettled();
    const stream = mocks.renderedStream;
    const appended = vi.fn();
    stream?.subscribe(appended);
    const terminalRenders = mocks.terminalRenders;
    const stateChanges = onStateChange.mock.calls.length;

    flushSync(() => {
      mocks.options?.onOutput?.('terminal-a', 'ls\r\n');
      mocks.options?.onOutput?.('terminal-a', 'a'.repeat(TERMINAL_OUTPUT_MAX_CHARS));
      mocks.options?.onOutput?.('terminal-a', 'past the cap\r\n');
      mocks.options?.onExit?.('terminal-a', 0);
    });

    expect(mocks.terminalRenders).toBe(terminalRenders);
    expect(onStateChange).toHaveBeenCalledTimes(stateChanges);
    expect(mocks.renderedStream).toBe(stream);
    expect(appended.mock.calls.map(([event]) => event.type)).toEqual([
      'append',
      'append',
      'append',
      'append',
    ]);
    expect(renderedOutput().endsWith('past the cap\r\n\r\n[Process exited with code 0]\r\n')).toBe(
      true
    );

    root.unmount();
  });

  it('keeps output written while hidden and replays it when shown again', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panel = trackPanel();
    const render = (isVisible: boolean) =>
      flushSync(() => {
        root.render(
          createElement(TerminalPanelHarness, {
            workspaceId: 'workspace-1',
            onStateChange: panel.onStateChange,
            isVisible,
          })
        );
      });

    render(true);
    flushSync(() => {
      panel.newTab();
    });
    flushSync(() => {
      mocks.options?.onCreated?.('terminal-a', mocks.create.mock.calls[0]?.[0], '$ ');
    });
    await vi.dynamicImportSettled();
    render(false);
    mocks.renderedStream = null;

    mocks.options?.onOutput?.('terminal-a', 'built while hidden\r\n');
    expect(mocks.renderedStream).toBeNull();

    render(true);
    expect(renderedOutput()).toBe('$ built while hidden\r\n');

    root.unmount();
  });
});
