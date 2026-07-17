// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { WORKSPACE_LOG_OUTPUT_MAX_CHARS, WORKSPACE_LOG_TRUNCATION_MARKER } from './rolling-output';
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
  isVisible: boolean;
  resultRef: { current: UseLogStreamResult | null };
  renderCountRef: { current: number };
}

function Harness({ endpoint, workspaceId, isVisible, resultRef, renderCountRef }: HarnessProps) {
  renderCountRef.current += 1;
  resultRef.current = useLogStream(endpoint, workspaceId, isVisible);
  return null;
}

describe('useLogStream', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mounted: boolean;
  let nextAnimationFrameId: number;
  let animationFrames: Map<number, FrameRequestCallback>;
  let requestAnimationFrameMock: ReturnType<typeof vi.fn>;
  let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;
  const resultRef: { current: UseLogStreamResult | null } = { current: null };
  const renderCountRef = { current: 0 };

  function render(
    isVisible = false,
    endpoint: '/dev-logs' | '/post-run-logs' = '/dev-logs',
    workspaceId = 'ws-1'
  ) {
    flushSync(() => {
      root.render(
        createElement(Harness, {
          endpoint,
          workspaceId,
          isVisible,
          resultRef,
          renderCountRef,
        })
      );
    });
  }

  function attachOutputEndMarker() {
    const marker = document.createElement('div');
    Object.defineProperty(marker, 'scrollIntoView', { value: scrollIntoViewMock });
    if (resultRef.current) {
      resultRef.current.outputEndRef.current = marker;
    }
  }

  function runAnimationFrames() {
    const pendingFrames = [...animationFrames.entries()];
    animationFrames.clear();
    for (const [, callback] of pendingFrames) {
      callback(0);
    }
  }

  function unmount() {
    if (!mounted) {
      return;
    }
    flushSync(() => {
      root.unmount();
    });
    mounted = false;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    capturedOptions = null;
    resultRef.current = null;
    renderCountRef.current = 0;
    nextAnimationFrameId = 1;
    animationFrames = new Map();
    requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextAnimationFrameId;
      nextAnimationFrameId += 1;
      animationFrames.set(frameId, callback);
      return frameId;
    });
    cancelAnimationFrameMock = vi.fn((frameId: number) => {
      animationFrames.delete(frameId);
    });
    scrollIntoViewMock = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(() => {
    unmount();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('connects to the given endpoint with the workspace id and drop queue policy', () => {
    render(false, '/post-run-logs');

    expect(capturedOptions?.url).toContain('/post-run-logs');
    expect(capturedOptions?.url).toContain('workspaceId=ws-1');
    expect(capturedOptions?.queuePolicy).toBe('drop');
  });

  it('buffers a high-frequency hidden burst without rerendering or scrolling', () => {
    render();
    attachOutputEndMarker();
    const rendersAfterMount = renderCountRef.current;

    flushSync(() => {
      for (let index = 0; index < 100; index += 1) {
        capturedOptions?.onMessage?.({ type: 'output', data: `line ${index}\n` });
      }
      vi.runAllTimers();
    });

    expect(renderCountRef.current).toBe(rendersAfterMount);
    expect(resultRef.current?.output).toBe('');
    expect(requestAnimationFrameMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('immediately hydrates buffered output when the stream becomes visible', () => {
    render();
    const originalUrl = capturedOptions?.url;
    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: 'line one\n' });
      capturedOptions?.onMessage?.({ type: 'output', data: 'line two\n' });
    });

    render(true);

    expect(resultRef.current?.output).toBe('line one\nline two\n');
    expect(capturedOptions?.url).toBe(originalUrl);
  });

  it('commits one output update for a high-frequency visible burst', () => {
    render(true);
    const rendersAfterMount = renderCountRef.current;

    flushSync(() => {
      for (let index = 0; index < 100; index += 1) {
        capturedOptions?.onMessage?.({ type: 'output', data: `${index},` });
      }
    });

    expect(resultRef.current?.output).toBe('');
    expect(renderCountRef.current).toBe(rendersAfterMount);

    flushSync(() => {
      vi.advanceTimersByTime(100);
    });

    expect(resultRef.current?.output).toBe(
      Array.from({ length: 100 }, (_, index) => `${index},`).join('')
    );
    expect(renderCountRef.current).toBe(rendersAfterMount + 1);
  });

  it('buffers lifecycle announcements while keeping disconnection state current', () => {
    render();

    flushSync(() => {
      capturedOptions?.onConnected?.();
      capturedOptions?.onDisconnected?.();
    });
    expect(resultRef.current?.hasDisconnected).toBe(true);
    expect(resultRef.current?.output).toBe('');

    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: 'while hidden\n' });
      capturedOptions?.onConnected?.();
    });
    expect(resultRef.current?.hasDisconnected).toBe(false);
    expect(resultRef.current?.output).toBe('');

    render(true);
    expect(resultRef.current?.output).toBe(
      'Connected!\n\nDisconnected. Reconnecting...\nwhile hidden\nReconnected!\n\n'
    );
  });

  it('bounds hidden buffered output with one truncation marker', () => {
    render();
    const chunk = 'x'.repeat(WORKSPACE_LOG_OUTPUT_MAX_CHARS / 2);

    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: chunk });
      capturedOptions?.onMessage?.({ type: 'output', data: chunk });
      capturedOptions?.onMessage?.({ type: 'output', data: 'newest' });
    });
    render(true);

    const output = resultRef.current?.output ?? '';
    expect(output).toHaveLength(WORKSPACE_LOG_OUTPUT_MAX_CHARS);
    expect(output.startsWith(WORKSPACE_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(output.match(/\[Earlier output truncated\]/g)).toHaveLength(1);
    expect(output.endsWith('newest')).toBe(true);
  });

  it('scrolls once on an animation frame after visible output is committed', () => {
    render(true);
    attachOutputEndMarker();

    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: 'one\n' });
      capturedOptions?.onMessage?.({ type: 'output', data: 'two\n' });
      capturedOptions?.onMessage?.({ type: 'output', data: 'three\n' });
      vi.advanceTimersByTime(100);
    });

    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    flushSync(() => {
      runAnimationFrames();
    });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth' });
  });

  it('cancels a pending visible flush when the stream becomes hidden', () => {
    render(true);
    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: 'pending\n' });
    });
    expect(vi.getTimerCount()).toBe(1);

    render(false);
    expect(vi.getTimerCount()).toBe(0);

    flushSync(() => {
      vi.runAllTimers();
    });
    expect(resultRef.current?.output).toBe('');

    render(true);
    expect(resultRef.current?.output).toBe('pending\n');
  });

  it('cancels pending flush and animation-frame work on unmount', () => {
    render(true);
    attachOutputEndMarker();
    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: 'first\n' });
      vi.advanceTimersByTime(100);
      capturedOptions?.onMessage?.({ type: 'output', data: 'second\n' });
    });
    expect(vi.getTimerCount()).toBe(1);
    expect(animationFrames.size).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(animationFrames.size).toBe(0);
    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1);
    flushSync(() => {
      vi.runAllTimers();
      runAnimationFrames();
    });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('ignores empty and schema-invalid messages', () => {
    render(true);

    flushSync(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: '' });
      capturedOptions?.onMessage?.({ type: 'exit', code: 1 });
      capturedOptions?.onMessage?.('garbage');
      vi.runAllTimers();
    });

    expect(resultRef.current?.output).toBe('');
    expect(requestAnimationFrameMock).not.toHaveBeenCalled();
  });
});
