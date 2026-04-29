// @vitest-environment jsdom

import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPanel, type TerminalPanelRef, type TerminalTabState } from './terminal-panel';

const terminalSocketMock = vi.hoisted(() => ({
  options: undefined as
    | {
        onOutput?: (terminalId: string, data: string) => void;
        onCreated?: (terminalId: string, requestId?: string) => void;
        onError?: (message: string, requestId?: string) => void;
      }
    | undefined,
  create: vi.fn(),
  destroy: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock('./use-terminal-websocket', () => ({
  useTerminalWebSocket: (options: typeof terminalSocketMock.options) => {
    terminalSocketMock.options = options;
    return {
      connected: true,
      create: terminalSocketMock.create,
      sendInput: vi.fn(),
      resize: vi.fn(),
      destroy: terminalSocketMock.destroy,
      setActive: terminalSocketMock.setActive,
    };
  },
}));

vi.mock('./terminal-instance', () => ({
  TerminalInstance: (props: { output: string }) =>
    createElement('pre', { 'data-testid': 'terminal-output' }, props.output),
}));

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

function getRequestIds(): [string, string] {
  const first = terminalSocketMock.create.mock.calls[0]?.[2];
  const second = terminalSocketMock.create.mock.calls[1]?.[2];
  expect(first).toEqual(expect.any(String));
  expect(second).toEqual(expect.any(String));
  expect(first).not.toBe(second);
  return [first, second];
}

beforeEach(() => {
  terminalSocketMock.options = undefined;
  terminalSocketMock.create.mockClear();
  terminalSocketMock.destroy.mockClear();
  terminalSocketMock.setActive.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TerminalPanel terminal creation', () => {
  it('associates out-of-order created responses with their requested tabs', async () => {
    const ref = createRef<TerminalPanelRef>();
    let tabState: TerminalTabState | undefined;
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(TerminalPanel, {
            ref,
            workspaceId: 'workspace-1',
            hideHeader: true,
            onStateChange: (state) => {
              tabState = state;
            },
          })
        );
      });
    });

    flushSync(() => {
      ref.current?.createNewTerminal();
      ref.current?.createNewTerminal();
    });

    const [firstRequestId, secondRequestId] = getRequestIds();
    expect(tabState?.tabs.map((tab) => tab.label)).toEqual(['Terminal 1', 'Terminal 2']);

    flushSync(() => {
      terminalSocketMock.options?.onOutput?.('terminal-2', 'second output');
      terminalSocketMock.options?.onCreated?.('terminal-2', secondRequestId);
      terminalSocketMock.options?.onOutput?.('terminal-1', 'first output');
      terminalSocketMock.options?.onCreated?.('terminal-1', firstRequestId);
    });

    flushSync(() => {
      tabState?.onSelectTab(tabState.tabs[0]?.id ?? '');
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('first output');
    });

    flushSync(() => {
      tabState?.onSelectTab(tabState.tabs[1]?.id ?? '');
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('second output');
    });
    expect(terminalSocketMock.setActive).toHaveBeenCalledWith('terminal-2');
    cleanup();
  });

  it('routes create errors to the matching pending tab', async () => {
    const ref = createRef<TerminalPanelRef>();
    let tabState: TerminalTabState | undefined;
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(TerminalPanel, {
            ref,
            workspaceId: 'workspace-1',
            hideHeader: true,
            onStateChange: (state) => {
              tabState = state;
            },
          })
        );
      });
    });

    flushSync(() => {
      ref.current?.createNewTerminal();
      ref.current?.createNewTerminal();
    });

    const [firstRequestId, secondRequestId] = getRequestIds();

    flushSync(() => {
      terminalSocketMock.options?.onError?.('creation failed', firstRequestId);
      terminalSocketMock.options?.onCreated?.('terminal-2', secondRequestId);
      terminalSocketMock.options?.onOutput?.('terminal-2', 'second output');
    });

    flushSync(() => {
      tabState?.onSelectTab(tabState.tabs[0]?.id ?? '');
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('[Error: creation failed]');
    });

    flushSync(() => {
      tabState?.onSelectTab(tabState.tabs[1]?.id ?? '');
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('second output');
    });
    cleanup();
  });

  it('destroys a terminal that finishes creating after its pending tab was closed', () => {
    const ref = createRef<TerminalPanelRef>();
    let tabState: TerminalTabState | undefined;
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(TerminalPanel, {
            ref,
            workspaceId: 'workspace-1',
            hideHeader: true,
            onStateChange: (state) => {
              tabState = state;
            },
          })
        );
      });
    });

    flushSync(() => {
      ref.current?.createNewTerminal();
    });

    const requestId = terminalSocketMock.create.mock.calls[0]?.[2];
    expect(requestId).toEqual(expect.any(String));

    flushSync(() => {
      tabState?.onCloseTab(tabState.tabs[0]?.id ?? '');
    });

    flushSync(() => {
      terminalSocketMock.options?.onCreated?.('terminal-orphan', requestId);
    });

    expect(terminalSocketMock.destroy).toHaveBeenCalledWith('terminal-orphan');
    cleanup();
  });

  it('activates a terminal created through a stale websocket callback', () => {
    const ref = createRef<TerminalPanelRef>();
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(TerminalPanel, {
            ref,
            workspaceId: 'workspace-1',
            hideHeader: true,
          })
        );
      });
    });
    const initialOnCreated = terminalSocketMock.options?.onCreated;

    flushSync(() => {
      ref.current?.createNewTerminal();
    });

    const requestId = terminalSocketMock.create.mock.calls[0]?.[2];
    expect(requestId).toEqual(expect.any(String));

    flushSync(() => {
      initialOnCreated?.('terminal-1', requestId);
    });

    expect(terminalSocketMock.setActive).toHaveBeenCalledWith('terminal-1');
    cleanup();
  });
});
