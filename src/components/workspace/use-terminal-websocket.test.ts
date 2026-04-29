import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { useTerminalWebSocket } from './use-terminal-websocket';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: (fn: (...args: never[]) => unknown) => fn,
  };
});

let capturedOptions: UseWebSocketTransportOptions | null = null;
const send = vi.fn();

vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (opts: UseWebSocketTransportOptions) => {
    capturedOptions = opts;
    return { connected: true, send, reconnect: vi.fn() };
  },
}));

describe('useTerminalWebSocket', () => {
  beforeEach(() => {
    capturedOptions = null;
    send.mockReset();
  });

  it('sends create request ids to correlate created responses', () => {
    const transport = useTerminalWebSocket({ workspaceId: 'workspace-1' });

    transport.create('request-1', 120, 40);

    expect(send).toHaveBeenCalledWith({
      type: 'create',
      requestId: 'request-1',
      cols: 120,
      rows: 40,
    });
  });

  it('passes created response request ids to consumers', () => {
    const onCreated = vi.fn();
    useTerminalWebSocket({ workspaceId: 'workspace-1', onCreated });

    capturedOptions?.onMessage?.({
      type: 'created',
      terminalId: 'terminal-1',
      requestId: 'request-1',
    });

    expect(onCreated).toHaveBeenCalledWith('terminal-1', 'request-1');
  });

  it('passes create error request ids to consumers', () => {
    const onError = vi.fn();
    useTerminalWebSocket({ workspaceId: 'workspace-1', onError });

    capturedOptions?.onMessage?.({
      type: 'error',
      message: 'creation failed',
      requestId: 'request-1',
    });

    expect(onError).toHaveBeenCalledWith('creation failed', 'request-1');
  });
});
