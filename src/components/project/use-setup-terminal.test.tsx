// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { type UseSetupTerminalResult, useSetupTerminal } from './use-setup-terminal';

let capturedOptions: UseWebSocketTransportOptions | null = null;
const send = vi.fn();
const transportState = { connected: false };

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (opts: UseWebSocketTransportOptions) => {
    capturedOptions = opts;
    return { connected: transportState.connected, gaveUp: false, send, reconnect: vi.fn() };
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
    transportState.connected = false;
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
