// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_TIMEOUT_MS, STABLE_CONNECTION_MS } from '@/lib/websocket-config';
import {
  FakeWebSocket,
  installFakeWebSocket,
  lastSocket,
  setDocumentVisibility,
} from './fake-websocket.test-helpers';
import { useWebSocketTransport } from './use-websocket-transport';
import { ConnectionHealthContext, ConnectionHealthStore } from './websocket-connection-health';
import {
  LIVENESS_ABANDON_AFTER_MS,
  LIVENESS_PING_INTERVAL_MS,
  LIVENESS_REPLY_TIMEOUT_MS,
} from './websocket-liveness';

const HELLO = { ffTransport: 'hello', version: '1.0.0' };

interface HarnessProps {
  url: string | null;
  announceConnectionLoss: boolean;
  onMessage: (data: unknown) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  connectedRef: { current: boolean };
}

function Harness({ connectedRef, ...options }: HarnessProps) {
  const { connected } = useWebSocketTransport(options);
  connectedRef.current = connected;
  return null;
}

function mount(options: { url?: string; announceConnectionLoss?: boolean } = {}) {
  const store = new ConnectionHealthStore();
  const container = document.createElement('div');
  const root = createRoot(container);
  const connectedRef = { current: false };
  const onMessage = vi.fn();
  const onConnected = vi.fn();
  const onDisconnected = vi.fn();
  const render = (url: string | null, announceConnectionLoss = options.announceConnectionLoss) =>
    flushSync(() =>
      root.render(
        createElement(
          ConnectionHealthContext.Provider,
          { value: store },
          createElement(Harness, {
            url,
            announceConnectionLoss: announceConnectionLoss ?? true,
            onMessage,
            onConnected,
            onDisconnected,
            connectedRef,
          })
        )
      )
    );
  render(options.url ?? '/snapshots?projectId=p1');
  return {
    store,
    connectedRef,
    onMessage,
    onConnected,
    onDisconnected,
    render,
    unmount: () => flushSync(() => root.unmount()),
  };
}

/** Opens the current socket and delivers the server's hello. */
function openWithHello(): FakeWebSocket {
  const socket = lastSocket();
  flushSync(() => socket.open());
  socket.receive(HELLO);
  return socket;
}

describe('useWebSocketTransport connection health', () => {
  beforeEach(() => {
    installFakeWebSocket();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    setDocumentVisibility('visible');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opts in to transport frames on the upgrade URL', () => {
    const view = mount({ url: '/chat?sessionId=s1' });
    expect(lastSocket().url).toBe('/chat?sessionId=s1&ffTransport=1');
    view.unmount();
  });

  it('never stops retrying, and waits at most the capped delay between attempts', async () => {
    const view = mount();
    openWithHello();
    flushSync(() => lastSocket().drop());
    expect(view.store.getSnapshot().connection).toBe('reconnecting');

    // Far past the old ten-attempt budget: every failure schedules another
    // attempt, never more than 10 s (plus jitter, zero here) later.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const failed = lastSocket();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lastSocket()).not.toBe(failed);
      flushSync(() => lastSocket().drop());
      expect(view.store.getSnapshot().connection).toBe('reconnecting');
    }

    await vi.advanceTimersByTimeAsync(10_000);
    openWithHello();
    expect(view.connectedRef.current).toBe(true);
    expect(view.store.getSnapshot().connection).toBe('ok');
    view.unmount();
  });

  it('reports a silent connection at once and abandons it only after a long silence', async () => {
    const view = mount();
    const socket = openWithHello();

    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.pings()).toEqual([0]);
    socket.answerPing();
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.pings()).toEqual([0, 1]);
    // Channel traffic proves the connection is alive just as a pong does.
    socket.receive({ type: 'snapshot_changed' });
    expect(view.onMessage).toHaveBeenCalledExactlyOnceWith({ type: 'snapshot_changed' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    // The server stops answering. One reply timeout after the unanswered ping,
    // eight seconds after the last frame at most, the banner says so; the
    // socket stays open in case the server is only slow.
    expect(socket.pings()).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(LIVENESS_REPLY_TIMEOUT_MS - 1);
    expect(view.store.getSnapshot().connection).toBe('ok');
    await vi.advanceTimersByTimeAsync(1);
    expect(view.store.getSnapshot().connection).toBe('unresponsive');
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    // After the long silence the socket is abandoned and replaced.
    await vi.advanceTimersByTimeAsync(LIVENESS_ABANDON_AFTER_MS - LIVENESS_REPLY_TIMEOUT_MS - 1);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(view.onDisconnected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(view.onDisconnected).toHaveBeenCalledOnce();
    expect(view.store.getSnapshot().connection).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1000);
    expect(lastSocket()).not.toBe(socket);
    // Transport frames never reach the channel.
    expect(view.onMessage).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('keeps the socket and replays nothing when a reply comes 6 s late', async () => {
    const view = mount();
    const socket = openWithHello();
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.pings()).toEqual([0]);

    // The server stalls for 6 s, then answers: the banner shows the silence
    // and clears with the reply, and nothing reconnects or replays.
    await vi.advanceTimersByTimeAsync(6000);
    expect(view.store.getSnapshot().connection).toBe('unresponsive');
    socket.answerPing();
    expect(view.store.getSnapshot().connection).toBe('ok');
    await vi.advanceTimersByTimeAsync(LIVENESS_ABANDON_AFTER_MS);

    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.created).toEqual([socket]);
    expect(view.onConnected).toHaveBeenCalledOnce();
    expect(view.onDisconnected).not.toHaveBeenCalled();
    view.unmount();
  });

  it('does not reset the backoff for an open that is followed by silence', async () => {
    const view = mount();
    const silentFor = async () => {
      await vi.advanceTimersByTimeAsync(LIVENESS_PING_INTERVAL_MS + LIVENESS_ABANDON_AFTER_MS);
    };
    // A server that accepts every upgrade and then stalls: each retry waits
    // longer (1 s, 2 s, 4 s), rather than 1 s every time.
    for (const delay of [1000, 2000, 4000]) {
      const socket = openWithHello();
      await silentFor();
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(lastSocket()).toBe(socket);
      await vi.advanceTimersByTimeAsync(1);
      expect(lastSocket()).not.toBe(socket);
    }

    // A connection that stays open and answering resets it.
    const healthy = openWithHello();
    for (let elapsed = 0; elapsed <= STABLE_CONNECTION_MS; elapsed += LIVENESS_PING_INTERVAL_MS) {
      await vi.advanceTimersByTimeAsync(LIVENESS_PING_INTERVAL_MS);
      healthy.answerPing();
    }
    flushSync(() => healthy.drop());
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastSocket()).not.toBe(healthy);
    view.unmount();
  });

  it('restarts the stability window when a late reply ends a silence', async () => {
    const view = mount();
    // Two failed attempts: the next delay is 4 s unless the backoff resets.
    flushSync(() => lastSocket().drop());
    await vi.advanceTimersByTimeAsync(1000);
    flushSync(() => lastSocket().drop());
    await vi.advanceTimersByTimeAsync(2000);

    const socket = openWithHello();
    await vi.advanceTimersByTimeAsync(LIVENESS_PING_INTERVAL_MS + LIVENESS_REPLY_TIMEOUT_MS);
    expect(view.store.getSnapshot().connection).toBe('unresponsive');
    // A late reply just before the window would have ended proves too little.
    await vi.advanceTimersByTimeAsync(STABLE_CONNECTION_MS - 8000 - 100);
    socket.answerPing();
    await vi.advanceTimersByTimeAsync(500);
    flushSync(() => socket.drop());

    await vi.advanceTimersByTimeAsync(4000 - 1);
    expect(lastSocket()).toBe(socket);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastSocket()).not.toBe(socket);
    view.unmount();
  });

  it('abandons and retries an attempt that never opens', async () => {
    const view = mount();
    const hanging = lastSocket();

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(hanging.readyState).toBe(FakeWebSocket.CONNECTING);
    await vi.advanceTimersByTimeAsync(1);
    expect(hanging.readyState).toBe(FakeWebSocket.CLOSED);
    expect(view.store.getSnapshot().connection).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastSocket()).not.toBe(hanging);
    view.unmount();
  });

  it('keeps a connection to an older server that sends no hello, without pinging it', async () => {
    const view = mount();
    const socket = lastSocket();
    flushSync(() => socket.open());

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // An older server would answer an unknown frame with a channel error.
    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.created).toHaveLength(1);
    expect(view.connectedRef.current).toBe(true);
    expect(view.store.getSnapshot()).toEqual({ connection: 'ok', serverVersion: null });
    view.unmount();
  });

  it('reports the server version from the hello', () => {
    const view = mount({ announceConnectionLoss: false });
    openWithHello();
    expect(view.store.getSnapshot().serverVersion).toBe('1.0.0');
    view.unmount();
  });

  it('does not ping or drop a healthy connection while the tab is hidden, and checks it when shown', async () => {
    const view = mount();
    const socket = openWithHello();
    setDocumentVisibility('hidden');

    // Throttled background timers would make any verdict here unreliable.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(socket.pings()).toEqual([]);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.created).toHaveLength(1);
    expect(view.store.getSnapshot().connection).toBe('ok');

    setDocumentVisibility('visible');
    expect(socket.pings()).toEqual([0]);
    socket.answerPing();
    await vi.advanceTimersByTimeAsync(3999);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(view.connectedRef.current).toBe(true);
    view.unmount();
  });

  it('drops a connection that died while the tab was hidden soon after it is shown', async () => {
    const view = mount();
    const socket = openWithHello();
    setDocumentVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60_000);

    setDocumentVisibility('visible');
    await vi.advanceTimersByTimeAsync(LIVENESS_REPLY_TIMEOUT_MS);
    expect(view.store.getSnapshot().connection).toBe('unresponsive');
    await vi.advanceTimersByTimeAsync(LIVENESS_ABANDON_AFTER_MS - LIVENESS_REPLY_TIMEOUT_MS);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(view.store.getSnapshot().connection).toBe('reconnecting');
    view.unmount();
  });

  it('re-arms a reply deadline that fires late after the machine slept', async () => {
    const view = mount();
    const socket = openWithHello();
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.pings()).toEqual([0]);

    // The machine sleeps for a minute with the ping in flight; on wake the
    // deadline fires long after it was due, before the queued reply arrives.
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    socket.answerPing();
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(view.store.getSnapshot().connection).toBe('ok');
    view.unmount();
  });

  it('does not report a channel switch or a channel without the banner opt-in as lost', async () => {
    const view = mount({ url: '/chat?sessionId=s1' });
    openWithHello();
    view.render('/chat?sessionId=s2');
    await vi.advanceTimersByTimeAsync(0);
    expect(view.store.getSnapshot().connection).toBe('ok');
    view.unmount();

    const terminal = mount({ url: '/terminal?workspaceId=w1', announceConnectionLoss: false });
    openWithHello();
    flushSync(() => lastSocket().drop());
    expect(terminal.store.getSnapshot().connection).toBe('ok');
    terminal.unmount();
  });

  it('publishes or withdraws its current state when the banner opt-in changes', () => {
    const url = '/chat?sessionId=s1';
    const view = mount({ url, announceConnectionLoss: false });
    openWithHello();
    flushSync(() => lastSocket().drop());
    expect(view.store.getSnapshot().connection).toBe('ok');

    view.render(url, true);
    expect(view.store.getSnapshot().connection).toBe('reconnecting');
    view.render(url, false);
    expect(view.store.getSnapshot().connection).toBe('ok');
    view.unmount();
  });

  it('withdraws its state when it unmounts', () => {
    const view = mount();
    openWithHello();
    flushSync(() => lastSocket().drop());
    expect(view.store.getSnapshot().connection).toBe('reconnecting');
    view.unmount();
    expect(view.store.getSnapshot().connection).toBe('ok');
  });
});
