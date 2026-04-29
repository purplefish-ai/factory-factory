// @vitest-environment jsdom

import { createElement, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalWebSocket } from './use-terminal-websocket';

const transportMock = vi.hoisted(() => ({
  options: undefined as
    | {
        url: string;
        onMessage: (data: unknown) => void;
        queuePolicy: string;
      }
    | undefined,
  send: vi.fn(),
}));

vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (options: typeof transportMock.options) => {
    transportMock.options = options;
    return {
      connected: true,
      send: transportMock.send,
    };
  },
}));

type TerminalSocketApi = ReturnType<typeof useTerminalWebSocket>;

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

function HookHarness(props: {
  onReady: (api: TerminalSocketApi) => void;
  onCreated: (terminalId: string, requestId?: string) => void;
  onError: (message: string, requestId?: string) => void;
}) {
  const api = useTerminalWebSocket({
    workspaceId: 'workspace-1',
    onCreated: props.onCreated,
    onError: props.onError,
  });

  useEffect(() => {
    props.onReady(api);
  }, [api, props]);

  return null;
}

beforeEach(() => {
  transportMock.options = undefined;
  transportMock.send.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useTerminalWebSocket', () => {
  it('sends and receives create requestIds for terminal correlation', () => {
    let api: TerminalSocketApi | undefined;
    const onCreated = vi.fn();
    const onError = vi.fn();
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          createElement(HookHarness, {
            onReady: (nextApi) => {
              api = nextApi;
            },
            onCreated,
            onError,
          })
        );
      });
    });

    api?.create(100, 30, 'request-1');

    expect(transportMock.send).toHaveBeenCalledWith({
      type: 'create',
      requestId: 'request-1',
      cols: 100,
      rows: 30,
    });

    transportMock.options?.onMessage({
      type: 'created',
      terminalId: 'terminal-1',
      requestId: 'request-1',
    });
    transportMock.options?.onMessage({
      type: 'error',
      message: 'failed',
      requestId: 'request-2',
    });

    expect(onCreated).toHaveBeenCalledWith('terminal-1', 'request-1');
    expect(onError).toHaveBeenCalledWith('failed', 'request-2');
    cleanup();
  });
});
