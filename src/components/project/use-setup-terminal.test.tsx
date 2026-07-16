// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_TRUNCATION_MARKER,
} from '@/components/workspace/rolling-output';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { type UseSetupTerminalResult, useSetupTerminal } from './use-setup-terminal';

let capturedOptions: UseWebSocketTransportOptions | null = null;
const send = vi.fn();
const reconnect = vi.fn();
const transportState = { connected: false, gaveUp: false };

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (opts: UseWebSocketTransportOptions) => {
    capturedOptions = opts;
    return { connected: transportState.connected, gaveUp: transportState.gaveUp, send, reconnect };
  },
}));

interface HarnessProps {
  open: boolean;
  resultRef: { current: UseSetupTerminalResult | null };
}

function Harness({ open, resultRef }: HarnessProps) {
  resultRef.current = useSetupTerminal(open);
  return null;
}

describe('useSetupTerminal', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const resultRef: { current: UseSetupTerminalResult | null } = { current: null };

  function render(open: boolean) {
    void act(() => {
      root.render(createElement(Harness, { open, resultRef }));
    });
  }

  function connect() {
    transportState.connected = true;
    render(true);
    void act(() => {
      capturedOptions?.onConnected?.();
    });
  }

  function disconnect() {
    transportState.connected = false;
    render(true);
    void act(() => {
      capturedOptions?.onDisconnected?.();
    });
  }

  beforeEach(() => {
    capturedOptions = null;
    resultRef.current = null;
    send.mockReset();
    reconnect.mockReset();
    transportState.connected = false;
    transportState.gaveUp = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not connect while the modal is closed', () => {
    render(false);

    expect(capturedOptions?.url).toBeNull();
  });

  it('connects to /setup-terminal when opened and requests a terminal on connect', () => {
    render(true);
    expect(capturedOptions?.url).toContain('/setup-terminal');

    connect();

    expect(send).toHaveBeenCalledWith({ type: 'create', cols: 80, rows: 24 });
  });

  it('accumulates output messages and ignores invalid ones', () => {
    render(true);
    connect();

    void act(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: '$ ' });
      capturedOptions?.onMessage?.({ type: 'output', data: 'gh auth login\r\n' });
      capturedOptions?.onMessage?.({ type: 'created' });
      capturedOptions?.onMessage?.('garbage');
    });

    expect(resultRef.current?.output).toBe('$ gh auth login\r\n');
  });

  it('keeps the terminal visible across a disconnect and requests a fresh shell on reconnect', () => {
    render(true);
    connect();
    expect(resultRef.current?.showTerminal).toBe(true);

    disconnect();
    expect(resultRef.current?.showTerminal).toBe(true);
    expect(resultRef.current?.connected).toBe(false);

    send.mockClear();
    connect();

    expect(send).toHaveBeenCalledWith({ type: 'create', cols: 80, rows: 24 });
    expect(resultRef.current?.output).toContain('starting a new shell');
  });

  it('sends input and resize messages, using the latest size for reconnect creates', () => {
    render(true);
    connect();

    void act(() => {
      resultRef.current?.handleData('ls\r');
      resultRef.current?.handleResize(120, 40);
    });

    expect(send).toHaveBeenCalledWith({ type: 'input', data: 'ls\r' });
    expect(send).toHaveBeenCalledWith({ type: 'resize', cols: 120, rows: 40 });

    disconnect();
    send.mockClear();
    connect();

    expect(send).toHaveBeenCalledWith({ type: 'create', cols: 120, rows: 40 });
  });

  it('ignores a connect that lands in the same render as the modal closing', () => {
    render(true);
    connect();
    disconnect();

    // Close the modal in the same render pass as the transport reporting a
    // (re)connect: the connect effect must not run for a closed modal.
    send.mockClear();
    transportState.connected = true;
    render(false);
    expect(send).not.toHaveBeenCalled();

    transportState.connected = false;
    render(false);

    render(true);
    connect();
    expect(resultRef.current?.output).not.toContain('starting a new shell');
  });

  it('exposes the transport gave-up state and manual reconnect', () => {
    render(true);
    expect(resultRef.current?.gaveUp).toBe(false);

    transportState.gaveUp = true;
    render(true);
    expect(resultRef.current?.gaveUp).toBe(true);

    resultRef.current?.reconnect();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('caps accumulated output with the terminal rolling buffer', () => {
    render(true);
    connect();

    void act(() => {
      capturedOptions?.onMessage?.({
        type: 'output',
        data: 'x'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 1024),
      });
    });

    const output = resultRef.current?.output ?? '';
    expect(output.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_MAX_CHARS);
    expect(output).toContain(TERMINAL_TRUNCATION_MARKER.trim());
  });

  it('resets output and terminal visibility when the modal closes', () => {
    render(true);
    connect();
    void act(() => {
      capturedOptions?.onMessage?.({ type: 'output', data: '$ ' });
    });

    transportState.connected = false;
    render(false);

    expect(resultRef.current?.output).toBe('');
    expect(resultRef.current?.showTerminal).toBe(false);
    expect(capturedOptions?.url).toBeNull();
  });
});
