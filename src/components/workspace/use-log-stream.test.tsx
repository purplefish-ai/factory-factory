// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { type UseLogStreamResult, useLogStream } from './use-log-stream';

let capturedOptions: UseWebSocketTransportOptions | null = null;

vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (opts: UseWebSocketTransportOptions) => {
    capturedOptions = opts;
    return { connected: true, gaveUp: false, send: vi.fn(), reconnect: vi.fn() };
  },
}));

interface HarnessProps {
  endpoint: '/dev-logs' | '/post-run-logs';
  workspaceId: string;
  resultRef: { current: UseLogStreamResult | null };
}

function Harness({ endpoint, workspaceId, resultRef }: HarnessProps) {
  resultRef.current = useLogStream(endpoint, workspaceId);
  return null;
}

describe('useLogStream', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const resultRef: { current: UseLogStreamResult | null } = { current: null };

  function render(endpoint: '/dev-logs' | '/post-run-logs' = '/dev-logs') {
    flushSync(() => {
      root.render(createElement(Harness, { endpoint, workspaceId: 'ws-1', resultRef }));
    });
  }

  beforeEach(() => {
    capturedOptions = null;
    resultRef.current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  });

  it('connects to the given endpoint with the workspace id and drop queue policy', () => {
    render('/post-run-logs');

    expect(capturedOptions?.url).toContain('/post-run-logs');
    expect(capturedOptions?.url).toContain('workspaceId=ws-1');
    expect(capturedOptions?.queuePolicy).toBe('drop');
  });

  it('appends output messages to the rolling output', () => {
    render();

    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: 'line one\n' });
      capturedOptions?.onMessage?.({ type: 'output', data: 'line two\n' });
    });

    expect(resultRef.current?.output).toBe('line one\nline two\n');
  });

  it('ignores messages that do not match the output schema', () => {
    render();

    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'exit', code: 1 });
      capturedOptions?.onMessage?.('garbage');
    });

    expect(resultRef.current?.output).toBe('');
  });

  it('announces Connected on first connect and Reconnected after output exists', () => {
    render();

    flushSync(() => {
      capturedOptions?.onConnected?.();
    });
    expect(resultRef.current?.output).toBe('Connected!\n\n');

    flushSync(() => {
      capturedOptions?.onDisconnected?.();
      capturedOptions?.onConnected?.();
    });
    expect(resultRef.current?.output).toContain('Reconnected!\n\n');
  });

  it('tracks disconnected state and announces reconnection attempts', () => {
    render();

    flushSync(() => {
      capturedOptions?.onDisconnected?.();
    });
    expect(resultRef.current?.hasDisconnected).toBe(true);
    expect(resultRef.current?.output).toContain('Disconnected. Reconnecting...\n');

    flushSync(() => {
      capturedOptions?.onConnected?.();
    });
    expect(resultRef.current?.hasDisconnected).toBe(false);
  });
});
