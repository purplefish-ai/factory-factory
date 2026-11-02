import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { sendStateful } from './websocket-send';

class Viewer extends EventEmitter {
  readyState: number = WS_READY_STATE.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  callbacks: ((error?: Error) => void)[] = [];
  close = vi.fn();
  terminate = vi.fn();
  send(message: string, callback: (error?: Error) => void) {
    this.sent.push(message);
    this.bufferedAmount += Buffer.byteLength(message);
    this.callbacks.push(callback);
  }
  socket(): WebSocket {
    return this as unknown as WebSocket;
  }
}
const logger = { error: vi.fn() };

afterEach(() => vi.useRealTimers());

describe('stateful viewer delivery', () => {
  it('retires a viewer at sustained backlog and never resumes a missed delta', () => {
    vi.useFakeTimers();
    const viewer = new Viewer();
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 4; i++) {
      expect(sendStateful(viewer.socket(), chunk, logger)).toBe(true);
    }
    expect(sendStateful(viewer.socket(), 'é', logger)).toBe(false);
    expect(viewer.close).toHaveBeenCalledExactlyOnceWith(1013, expect.any(String));
    viewer.bufferedAmount = 0;
    expect(sendStateful(viewer.socket(), 'later delta', logger)).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(viewer.terminate).toHaveBeenCalledTimes(1);
    expect(viewer.sent).toHaveLength(4);
    expect(viewer.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retirement deadline and listener when close completes', () => {
    vi.useFakeTimers();
    const viewer = new Viewer();
    viewer.bufferedAmount = 1024 * 1024;
    sendStateful(viewer.socket(), 'delta', logger);
    viewer.readyState = WS_READY_STATE.CLOSED;
    viewer.emit('close');
    vi.advanceTimersByTime(5000);
    expect(viewer.terminate).not.toHaveBeenCalled();
    expect(viewer.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows one large authoritative frame and completion metadata then bounds further backlog', () => {
    vi.useFakeTimers();
    const viewer = new Viewer();
    const baseline = 'x'.repeat(2 * 1024 * 1024);
    expect(
      sendStateful(viewer.socket(), baseline, logger, 'baseline', { allowLargeFrame: true })
    ).toBe(true);
    expect(sendStateful(viewer.socket(), 'configuration', logger)).toBe(true);
    expect(sendStateful(viewer.socket(), 'x'.repeat(1024 * 1024), logger)).toBe(false);
    expect(viewer.sent).toEqual([baseline, 'configuration']);
    expect(viewer.close).toHaveBeenCalledTimes(1);
    viewer.emit('close');
    expect(viewer.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases large frame allowance on successful flush and supports another load after drain', () => {
    const viewer = new Viewer();
    const baseline = 'x'.repeat(2 * 1024 * 1024);
    sendStateful(viewer.socket(), baseline, logger, 'baseline', { allowLargeFrame: true });
    viewer.bufferedAmount = 0;
    viewer.callbacks[0]?.();
    expect(viewer.listenerCount('close')).toBe(0);
    expect(
      sendStateful(viewer.socket(), baseline, logger, 'baseline', { allowLargeFrame: true })
    ).toBe(true);
    viewer.callbacks[1]?.();
  });

  it('does not grant a second large frame exemption to an already queued connection', () => {
    vi.useFakeTimers();
    const viewer = new Viewer();
    viewer.bufferedAmount = 1;
    expect(
      sendStateful(viewer.socket(), 'x'.repeat(2 * 1024 * 1024), logger, 'baseline', {
        allowLargeFrame: true,
      })
    ).toBe(false);
    expect(viewer.close).toHaveBeenCalledTimes(1);
    viewer.emit('close');
  });

  it('does not retain a retirement timer when a synchronous write failure already closed the socket', () => {
    vi.useFakeTimers();
    const viewer = new Viewer();
    vi.spyOn(viewer, 'send').mockImplementation(() => {
      viewer.readyState = WS_READY_STATE.CLOSED;
      viewer.emit('close');
      throw new Error('closed during write');
    });
    expect(sendStateful(viewer.socket(), 'delta', logger)).toBe(false);
    expect(viewer.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires on asynchronous send failure instead of continuing a broken state stream', () => {
    vi.useFakeTimers();
    const viewer = new Viewer();
    expect(sendStateful(viewer.socket(), 'delta', logger)).toBe(true);
    viewer.callbacks[0]?.(new Error('write failed'));
    expect(viewer.close).toHaveBeenCalledTimes(1);
    expect(sendStateful(viewer.socket(), 'later', logger)).toBe(false);
    viewer.emit('close');
  });
});
