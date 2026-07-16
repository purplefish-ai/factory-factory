import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WS_READY_STATE, type WsReadyState } from '@/backend/constants/websocket';
import { TopicBroadcaster } from './topic-broadcaster';

class MockWebSocket {
  readyState: WsReadyState = WS_READY_STATE.OPEN;
  send = vi.fn();

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function createBroadcaster(): TopicBroadcaster<string> {
  return new TopicBroadcaster<string>({ error: vi.fn() });
}

describe('TopicBroadcaster', () => {
  describe('subscribe', () => {
    it('tracks subscribers per topic', () => {
      const broadcaster = createBroadcaster();
      const ws = new MockWebSocket();

      broadcaster.subscribe('topic-a', ws.asWebSocket());

      expect(broadcaster.subscriberCount('topic-a')).toBe(1);
      expect(broadcaster.subscriberCount('topic-b')).toBe(0);
      expect(broadcaster.hasSubscribers('topic-a')).toBe(true);
    });

    it('removes the subscription when the disposer runs', () => {
      const broadcaster = createBroadcaster();
      const ws = new MockWebSocket();

      const dispose = broadcaster.subscribe('topic-a', ws.asWebSocket());
      dispose();

      expect(broadcaster.subscriberCount('topic-a')).toBe(0);
      expect(broadcaster.hasSubscribers('topic-a')).toBe(false);
    });

    it('fires onEmpty only when the last subscriber leaves', () => {
      const broadcaster = createBroadcaster();
      const onEmpty = vi.fn();
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      const dispose1 = broadcaster.subscribe('topic-a', ws1.asWebSocket(), onEmpty);
      const dispose2 = broadcaster.subscribe('topic-a', ws2.asWebSocket(), onEmpty);

      dispose1();
      expect(onEmpty).not.toHaveBeenCalled();

      dispose2();
      expect(onEmpty).toHaveBeenCalledTimes(1);
    });

    it('is safe to dispose twice', () => {
      const broadcaster = createBroadcaster();
      const onEmpty = vi.fn();
      const ws = new MockWebSocket();

      const dispose = broadcaster.subscribe('topic-a', ws.asWebSocket(), onEmpty);
      dispose();
      dispose();

      expect(onEmpty).toHaveBeenCalledTimes(1);
    });

    it('keeps distinct topics independent', () => {
      const broadcaster = createBroadcaster();
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      broadcaster.subscribe('topic-a', ws1.asWebSocket());
      broadcaster.subscribe('topic-b', ws2.asWebSocket());

      broadcaster.broadcast('topic-a', { hello: 'a' });

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify({ hello: 'a' }));
      expect(ws2.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('sends the serialized payload to every subscriber of the topic', () => {
      const broadcaster = createBroadcaster();
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      broadcaster.subscribe('topic-a', ws1.asWebSocket());
      broadcaster.subscribe('topic-a', ws2.asWebSocket());

      const sent = broadcaster.broadcast('topic-a', { type: 'test' });

      expect(sent).toBe(2);
      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify({ type: 'test' }));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'test' }));
    });

    it('passes string payloads through without re-serializing', () => {
      const broadcaster = createBroadcaster();
      const ws = new MockWebSocket();
      broadcaster.subscribe('topic-a', ws.asWebSocket());

      broadcaster.broadcast('topic-a', 'raw-message');

      expect(ws.send).toHaveBeenCalledWith('raw-message');
    });

    it('skips sockets that are not OPEN', () => {
      const broadcaster = createBroadcaster();
      const closed = new MockWebSocket();
      closed.readyState = WS_READY_STATE.CLOSED;
      const open = new MockWebSocket();

      broadcaster.subscribe('topic-a', closed.asWebSocket());
      broadcaster.subscribe('topic-a', open.asWebSocket());

      const sent = broadcaster.broadcast('topic-a', { type: 'test' });

      expect(sent).toBe(1);
      expect(closed.send).not.toHaveBeenCalled();
      expect(open.send).toHaveBeenCalled();
    });

    it('continues past a socket whose send throws', () => {
      const logger = { error: vi.fn() };
      const broadcaster = new TopicBroadcaster<string>(logger);
      const throwing = new MockWebSocket();
      throwing.send.mockImplementation(() => {
        throw new Error('socket closing');
      });
      const healthy = new MockWebSocket();

      broadcaster.subscribe('topic-a', throwing.asWebSocket());
      broadcaster.subscribe('topic-a', healthy.asWebSocket());

      const sent = broadcaster.broadcast('topic-a', { type: 'test' });

      expect(sent).toBe(1);
      expect(healthy.send).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it('returns 0 for a topic with no subscribers', () => {
      const broadcaster = createBroadcaster();
      expect(broadcaster.broadcast('missing', { type: 'test' })).toBe(0);
    });
  });

  describe('subscribers', () => {
    it('exposes a live view for per-socket fan-out decisions', () => {
      const broadcaster = createBroadcaster();
      const ws = new MockWebSocket();
      broadcaster.subscribe('topic-a', ws.asWebSocket());

      const view = broadcaster.subscribers('topic-a');
      expect([...view]).toEqual([ws.asWebSocket()]);
      expect([...broadcaster.subscribers('missing')]).toEqual([]);
    });
  });
});
