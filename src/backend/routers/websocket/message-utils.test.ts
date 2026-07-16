import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { parseWebSocketMessage, sendJsonError, toMessageString } from './message-utils';

const TestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
]);

function createLogger() {
  return { warn: vi.fn() };
}

describe('toMessageString', () => {
  it('passes strings through and decodes buffers', () => {
    expect(toMessageString('hello')).toBe('hello');
    expect(toMessageString(Buffer.from('hello'))).toBe('hello');
  });
});

describe('parseWebSocketMessage', () => {
  it('returns the parsed message for valid input', () => {
    const logger = createLogger();

    const message = parseWebSocketMessage(
      TestSchema,
      JSON.stringify({ type: 'input', data: 'ls\n' }),
      logger,
      'test message'
    );

    expect(message).toEqual({ type: 'input', data: 'ls\n' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null and warns when the payload is not valid JSON', () => {
    const logger = createLogger();

    const message = parseWebSocketMessage(TestSchema, 'not json', logger, 'test message');

    expect(message).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('Invalid test message format', expect.any(Object));
  });

  it('returns null and warns with schema issues when validation fails', () => {
    const logger = createLogger();

    const message = parseWebSocketMessage(
      TestSchema,
      JSON.stringify({ type: 'unknown' }),
      logger,
      'test message',
      { workspaceId: 'workspace-1' }
    );

    expect(message).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'Invalid test message format',
      expect.objectContaining({ workspaceId: 'workspace-1', errors: expect.any(Array) })
    );
  });
});

describe('sendJsonError', () => {
  it('sends an error payload on open sockets', () => {
    const ws = { readyState: WS_READY_STATE.OPEN, send: vi.fn() } as unknown as WebSocket;

    sendJsonError(ws, 'Something failed', 'request-1');

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Something failed', requestId: 'request-1' })
    );
  });

  it('omits requestId when not provided', () => {
    const ws = { readyState: WS_READY_STATE.OPEN, send: vi.fn() } as unknown as WebSocket;

    sendJsonError(ws, 'Something failed');

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Something failed' })
    );
  });

  it('does nothing on closed sockets', () => {
    const ws = { readyState: WS_READY_STATE.CLOSED, send: vi.fn() } as unknown as WebSocket;

    sendJsonError(ws, 'Something failed');

    expect(ws.send).not.toHaveBeenCalled();
  });
});
