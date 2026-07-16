// @vitest-environment jsdom

import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_OUTPUT_MAX_CHARS, TERMINAL_TRUNCATION_MARKER } from './rolling-output';
import { TerminalPanel, type TerminalPanelRef } from './terminal-panel';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  destroy: vi.fn(),
  setActive: vi.fn(),
  reconnect: vi.fn(),
  connected: true,
  gaveUp: false,
  renderedOutput: '',
  options: null as {
    onCreated?: (terminalId: string, requestId?: string, outputBuffer?: string) => void;
    onOutput?: (terminalId: string, data: string) => void;
    onError?: (message: string, requestId?: string) => void;
    onTerminalList?: (
      terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>
    ) => void;
  } | null,
}));

vi.mock('lucide-react', () => ({
  Terminal: () => null,
}));

vi.mock('./terminal-instance', () => ({
  TerminalInstance: ({ output }: { output: string }) => {
    mocks.renderedOutput = output;
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
    mocks.renderedOutput = '';
    mocks.options = null;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the server active terminal aligned with the selected pending tab', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });

    flushSync(() => {
      panelRef.current?.createNewTerminal();
      panelRef.current?.createNewTerminal();
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
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });

    flushSync(() => {
      panelRef.current?.createNewTerminal();
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
    mocks.connected = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });
    flushSync(() => {
      panelRef.current?.createNewTerminal();
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
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });
    flushSync(() => {
      panelRef.current?.createNewTerminal();
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
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });
    flushSync(() => {
      panelRef.current?.createNewTerminal();
    });
    await vi.dynamicImportSettled();

    expect(container.textContent).not.toContain('disconnected');

    root.unmount();
  });

  it('bounds live terminal output for associated tabs', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });

    flushSync(() => {
      panelRef.current?.createNewTerminal();
    });

    const requestId = mocks.create.mock.calls[0]?.[0] as string;

    flushSync(() => {
      mocks.options?.onCreated?.('terminal-a', requestId);
      mocks.options?.onOutput?.('terminal-a', 'a'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 100));
    });
    await vi.dynamicImportSettled();

    expect(mocks.renderedOutput.length).toBe(TERMINAL_OUTPUT_MAX_CHARS);
    expect(mocks.renderedOutput.startsWith(TERMINAL_TRUNCATION_MARKER)).toBe(true);
    expect(mocks.renderedOutput.endsWith('a'.repeat(100))).toBe(true);

    root.unmount();
  });

  it('renders the created output buffer before client-buffered output', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });

    flushSync(() => {
      panelRef.current?.createNewTerminal();
    });

    const requestId = mocks.create.mock.calls[0]?.[0] as string;

    flushSync(() => {
      mocks.options?.onOutput?.('terminal-a', 'live output');
      mocks.options?.onCreated?.('terminal-a', requestId, 'early prompt $ ');
    });
    await vi.dynamicImportSettled();

    expect(mocks.renderedOutput).toBe('early prompt $ live output');

    root.unmount();
  });

  it('bounds pending terminal output before a tab is associated', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const panelRef = createRef<TerminalPanelRef>();

    flushSync(() => {
      root.render(createElement(TerminalPanel, { workspaceId: 'workspace-1', ref: panelRef }));
    });

    flushSync(() => {
      panelRef.current?.createNewTerminal();
    });

    const requestId = mocks.create.mock.calls[0]?.[0] as string;

    flushSync(() => {
      mocks.options?.onOutput?.('terminal-a', 'b'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 100));
      mocks.options?.onCreated?.('terminal-a', requestId);
    });
    await vi.dynamicImportSettled();

    expect(mocks.renderedOutput.length).toBe(TERMINAL_OUTPUT_MAX_CHARS);
    expect(mocks.renderedOutput.startsWith(TERMINAL_TRUNCATION_MARKER)).toBe(true);
    expect(mocks.renderedOutput.endsWith('b'.repeat(100))).toBe(true);

    root.unmount();
  });
});
