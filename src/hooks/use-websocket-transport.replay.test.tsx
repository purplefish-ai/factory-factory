// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWebSocketTransportReturn } from './use-websocket-transport';
import { useWebSocketTransport } from './use-websocket-transport';

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

class MockWebSocket {
  static CONNECTING = WS_CONNECTING;
  static OPEN = WS_OPEN;
  static CLOSING = WS_CLOSING;
  static CLOSED = WS_CLOSED;

  readonly url: string;
  readyState = WS_CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    createdSockets.push(this);
  }

  send(data: string) {
    if (this.readyState !== WS_OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = WS_CLOSED;
    this.onclose?.({ type: 'close' });
  }

  simulateOpen() {
    this.readyState = WS_OPEN;
    this.onopen?.({ type: 'open' });
  }
}

let createdSockets: MockWebSocket[] = [];

function getLastSocket(): MockWebSocket {
  const socket = createdSockets.at(-1);
  if (!socket) {
    throw new Error('No mock socket created');
  }
  return socket;
}

interface TransportHarnessProps {
  url: string | null;
  onConnected?: () => void;
  transportRef: { current: UseWebSocketTransportReturn | null };
}

function TransportHarness({ url, onConnected, transportRef }: TransportHarnessProps) {
  const transport = useWebSocketTransport({
    url,
    onConnected,
    queuePolicy: 'replay',
  });
  transportRef.current = transport;
  return null;
}

function createHarness(options: { onConnected?: () => void } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const transportRef = { current: null as UseWebSocketTransportReturn | null };

  flushSync(() => {
    root.render(
      createElement(TransportHarness, {
        url: 'ws://localhost:3000/chat',
        onConnected: options.onConnected,
        transportRef,
      })
    );
  });

  return {
    transportRef,
    cleanup: () => {
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

function extractMessageIds(socket: MockWebSocket): Array<number | string> {
  return socket.sentMessages.map((raw) => {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
      throw new Error('Missing id in sent message');
    }
    const id = parsed.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new Error('Invalid id in sent message');
    }
    return id;
  });
}

describe('useWebSocketTransport replay queue', () => {
  beforeEach(() => {
    createdSockets = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    createdSockets = [];
  });

  it('flushes all queued messages even when queue exceeds batch size', async () => {
    const harness = createHarness();
    await flushEffects();

    const transport = harness.transportRef.current;
    if (!transport) {
      throw new Error('Transport was not initialized');
    }
    const socket = getLastSocket();

    for (let id = 1; id <= 25; id += 1) {
      expect(transport.send({ id })).toBe(false);
    }

    flushSync(() => {
      socket.simulateOpen();
    });

    expect(extractMessageIds(socket)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));

    harness.cleanup();
  });

  it('preserves FIFO ordering when onConnected sends after reconnect replay', async () => {
    let transportRef: { current: UseWebSocketTransportReturn | null } | null = null;

    const harness = createHarness({
      onConnected: () => {
        const transport = transportRef?.current;
        if (!transport) {
          return;
        }
        transport.send({ id: 'after-reconnect' });
      },
    });
    transportRef = harness.transportRef;
    await flushEffects();

    const transport = harness.transportRef.current;
    if (!transport) {
      throw new Error('Transport was not initialized');
    }
    const socket = getLastSocket();

    for (let id = 1; id <= 15; id += 1) {
      expect(transport.send({ id })).toBe(false);
    }

    flushSync(() => {
      socket.simulateOpen();
    });

    expect(extractMessageIds(socket)).toEqual([
      ...Array.from({ length: 15 }, (_, index) => index + 1),
      'after-reconnect',
    ]);

    harness.cleanup();
  });
});
