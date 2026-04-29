// @vitest-environment jsdom

import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPanel, type TerminalPanelRef } from './terminal-panel';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  destroy: vi.fn(),
  setActive: vi.fn(),
  options: null as { onCreated?: (terminalId: string, requestId?: string) => void } | null,
}));

vi.mock('lucide-react', () => ({
  Terminal: () => null,
}));

vi.mock('./terminal-instance', () => ({
  TerminalInstance: () => null,
}));

vi.mock('./terminal-tab-bar', () => ({
  TerminalTabBar: () => null,
}));

vi.mock('./use-terminal-websocket', () => ({
  useTerminalWebSocket: (options: typeof mocks.options) => {
    mocks.options = options;
    return {
      connected: true,
      create: mocks.create,
      sendInput: mocks.sendInput,
      resize: mocks.resize,
      destroy: mocks.destroy,
      setActive: mocks.setActive,
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
});
