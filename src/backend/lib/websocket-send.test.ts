import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { safeSend } from './websocket-send';

function createMockWs(readyState: number = WS_READY_STATE.OPEN) {
  return {
    readyState,
    send: vi.fn(),
  };
}

function createMockLogger() {
  return { error: vi.fn() };
}

describe('safeSend', () => {
  it('sends the message when the socket is OPEN and returns true', () => {
    const ws = createMockWs();
    const logger = createMockLogger();

    const result = safeSend(ws as unknown as WebSocket, 'hello', logger);

    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('hello');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not send when the socket is not OPEN and returns false', () => {
    const ws = createMockWs(WS_READY_STATE.CLOSING);
    const logger = createMockLogger();

    const result = safeSend(ws as unknown as WebSocket, 'hello', logger);

    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('catches a synchronous send error, logs it, and returns false', () => {
    const ws = createMockWs();
    ws.send.mockImplementation(() => {
      throw new Error('socket closing');
    });
    const logger = createMockLogger();

    const result = safeSend(ws as unknown as WebSocket, 'hello', logger, 'test message');

    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to send test message',
      expect.objectContaining({ message: 'socket closing' })
    );
  });
});
