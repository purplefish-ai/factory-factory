import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGetQueueHandler } from './get-queue.handler';

const mockFindById = vi.fn();
const mockGetClient = vi.fn();
const mockSubscribe = vi.fn();

vi.mock('../../../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

vi.mock('../../session.service', () => ({
  sessionService: {
    getClient: (...args: unknown[]) => mockGetClient(...args),
  },
}));

vi.mock('../../session-store.service', () => ({
  sessionStoreService: {
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
  },
}));

describe('createGetQueueHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends error when session does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    const send = vi.fn();
    const handler = createGetQueueHandler();

    await handler({
      ws: { send } as never,
      sessionId: 'missing-session',
      workingDir: '/tmp',
      message: { type: 'get_queue' } as never,
    });

    expect(send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Session not found' })
    );
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('subscribes session when session exists', async () => {
    mockFindById.mockResolvedValue({
      id: 's1',
      claudeSessionId: 'claude-1',
    });
    mockGetClient.mockReturnValue({
      isRunning: () => true,
      isWorking: () => false,
    });
    const send = vi.fn();
    const handler = createGetQueueHandler();

    await handler({
      ws: { send } as never,
      sessionId: 's1',
      workingDir: '/workspace',
      message: { type: 'get_queue' } as never,
    });

    expect(send).not.toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledWith({
      sessionId: 's1',
      workingDir: '/workspace',
      claudeSessionId: 'claude-1',
      isRunning: true,
      isWorking: false,
    });
  });
});
