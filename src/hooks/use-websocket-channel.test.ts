import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { useWebSocketChannel } from './use-websocket-channel';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: (fn: (...args: never[]) => unknown) => fn,
  };
});

let capturedOptions: UseWebSocketTransportOptions | null = null;
const send = vi.fn();
const reconnect = vi.fn();

vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (opts: UseWebSocketTransportOptions) => {
    capturedOptions = opts;
    return { connected: true, gaveUp: false, send, reconnect };
  },
}));

const TestSchema = z.object({
  type: z.literal('output'),
  data: z.string().optional(),
});

describe('useWebSocketChannel', () => {
  beforeEach(() => {
    capturedOptions = null;
    send.mockReset();
    reconnect.mockReset();
  });

  it('passes url, queue policy, and lifecycle callbacks through to the transport', () => {
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();

    useWebSocketChannel({
      url: 'ws://example.test/logs',
      schema: TestSchema,
      onMessage: vi.fn(),
      onConnected,
      onDisconnected,
      queuePolicy: 'drop',
    });

    expect(capturedOptions?.url).toBe('ws://example.test/logs');
    expect(capturedOptions?.queuePolicy).toBe('drop');

    capturedOptions?.onConnected?.();
    capturedOptions?.onDisconnected?.();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('delivers schema-valid messages to onMessage', () => {
    const onMessage = vi.fn();
    useWebSocketChannel({ url: 'ws://example.test', schema: TestSchema, onMessage });

    capturedOptions?.onMessage?.({ type: 'output', data: 'hello' });

    expect(onMessage).toHaveBeenCalledWith({ type: 'output', data: 'hello' });
  });

  it('silently drops messages that fail schema validation', () => {
    const onMessage = vi.fn();
    useWebSocketChannel({ url: 'ws://example.test', schema: TestSchema, onMessage });

    capturedOptions?.onMessage?.({ type: 'unexpected' });
    capturedOptions?.onMessage?.('not an object');
    capturedOptions?.onMessage?.(null);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('exposes the transport connection state and controls', () => {
    const channel = useWebSocketChannel({
      url: 'ws://example.test',
      schema: TestSchema,
      onMessage: vi.fn(),
    });

    expect(channel.connected).toBe(true);
    expect(channel.gaveUp).toBe(false);

    channel.send({ type: 'input', data: 'x' });
    channel.reconnect();
    expect(send).toHaveBeenCalledWith({ type: 'input', data: 'x' });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
