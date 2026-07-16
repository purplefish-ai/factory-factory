import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { MAX_WEBSOCKET_STREAM_BUFFERED_BYTES, safeSend, sendStreamOutput } from './websocket-send';

function createMockWs(readyState: number = WS_READY_STATE.OPEN, bufferedAmount = 0) {
  return {
    readyState,
    bufferedAmount,
    send: vi.fn(),
  };
}

function createMockLogger() {
  return { error: vi.fn(), warn: vi.fn() };
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

describe('sendStreamOutput', () => {
  it('sends stream output with a callback at or below the threshold', () => {
    const ws = createMockWs(WS_READY_STATE.OPEN, MAX_WEBSOCKET_STREAM_BUFFERED_BYTES);
    const logger = createMockLogger();

    expect(sendStreamOutput(ws as unknown as WebSocket, 'output', logger, 'terminal output')).toBe(
      true
    );

    expect(ws.send).toHaveBeenCalledWith('output', expect.any(Function));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops output and warns once while a socket remains congested', () => {
    const ws = createMockWs(WS_READY_STATE.OPEN, MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1);
    const logger = createMockLogger();

    expect(sendStreamOutput(ws as unknown as WebSocket, 'first', logger, 'log output')).toBe(false);
    expect(sendStreamOutput(ws as unknown as WebSocket, 'second', logger, 'log output')).toBe(
      false
    );

    expect(ws.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Dropping log output because WebSocket send buffer is congested',
      {
        bufferedAmount: MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1,
        maxBufferedAmount: MAX_WEBSOCKET_STREAM_BUFFERED_BYTES,
      }
    );
  });

  it('resumes output and allows a new warning after the socket drains', () => {
    const ws = createMockWs(WS_READY_STATE.OPEN, MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1);
    const logger = createMockLogger();

    sendStreamOutput(ws as unknown as WebSocket, 'dropped', logger);
    ws.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES;
    expect(sendStreamOutput(ws as unknown as WebSocket, 'resumed', logger)).toBe(true);

    ws.bufferedAmount = MAX_WEBSOCKET_STREAM_BUFFERED_BYTES + 1;
    expect(sendStreamOutput(ws as unknown as WebSocket, 'dropped again', logger)).toBe(false);

    expect(ws.send).toHaveBeenCalledWith('resumed', expect.any(Function));
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs asynchronous send callback errors', () => {
    const ws = createMockWs();
    ws.send.mockImplementation((_message: string, callback: (error?: Error) => void) => {
      callback(new Error('write failed'));
    });
    const logger = createMockLogger();

    expect(sendStreamOutput(ws as unknown as WebSocket, 'output', logger, 'terminal output')).toBe(
      true
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to send terminal output',
      expect.objectContaining({ message: 'write failed' })
    );
  });

  it('catches synchronous stream send errors and ignores closed sockets', () => {
    const throwingWs = createMockWs();
    throwingWs.send.mockImplementation(() => {
      throw new Error('socket closing');
    });
    const logger = createMockLogger();

    expect(
      sendStreamOutput(throwingWs as unknown as WebSocket, 'output', logger, 'terminal output')
    ).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to send terminal output',
      expect.objectContaining({ message: 'socket closing' })
    );

    const closedWs = createMockWs(WS_READY_STATE.CLOSED);
    expect(sendStreamOutput(closedWs as unknown as WebSocket, 'output', logger)).toBe(false);
    expect(closedWs.send).not.toHaveBeenCalled();
  });
});
