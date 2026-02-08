import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tryHandleAsInteractiveResponse } from './interactive-response';

const mockGetClient = vi.fn();
const mockGetPendingInteractiveRequest = vi.fn();
const mockClearPendingInteractiveRequestIfMatches = vi.fn();
const mockAllocateOrder = vi.fn();
const mockEmitDelta = vi.fn();

vi.mock('../session.service', () => ({
  sessionService: {
    getClient: (...args: unknown[]) => mockGetClient(...args),
  },
}));

vi.mock('../session-store.service', () => ({
  sessionStoreService: {
    getPendingInteractiveRequest: (...args: unknown[]) => mockGetPendingInteractiveRequest(...args),
    clearPendingInteractiveRequestIfMatches: (...args: unknown[]) =>
      mockClearPendingInteractiveRequestIfMatches(...args),
    allocateOrder: (...args: unknown[]) => mockAllocateOrder(...args),
    emitDelta: (...args: unknown[]) => mockEmitDelta(...args),
  },
}));

describe('tryHandleAsInteractiveResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAllocateOrder.mockReturnValue(42);
  });

  it('emits message_used_as_response exactly once through session store delta', () => {
    const denyInteractiveRequest = vi.fn();
    mockGetClient.mockReturnValue({
      denyInteractiveRequest,
    });
    mockGetPendingInteractiveRequest.mockReturnValue({
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      input: {},
    });

    const handled = tryHandleAsInteractiveResponse('session-1', 'msg-1', 'response text');

    expect(handled).toBe(true);
    expect(mockClearPendingInteractiveRequestIfMatches).toHaveBeenCalledWith('session-1', 'req-1');
    expect(mockAllocateOrder).toHaveBeenCalledWith('session-1');
    expect(denyInteractiveRequest).toHaveBeenCalledWith('req-1', 'response text');
    expect(mockEmitDelta).toHaveBeenCalledTimes(1);
    expect(mockEmitDelta).toHaveBeenCalledWith('session-1', {
      type: 'message_used_as_response',
      id: 'msg-1',
      text: 'response text',
      order: 42,
    });
  });

  it('keeps pending request and emits error when interactive delivery fails', () => {
    const denyInteractiveRequest = vi.fn(() => {
      throw new Error('transport down');
    });
    mockGetClient.mockReturnValue({
      denyInteractiveRequest,
    });
    mockGetPendingInteractiveRequest.mockReturnValue({
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      input: {},
    });

    const handled = tryHandleAsInteractiveResponse('session-1', 'msg-1', 'response text');

    expect(handled).toBe(true);
    expect(mockClearPendingInteractiveRequestIfMatches).not.toHaveBeenCalled();
    expect(mockAllocateOrder).not.toHaveBeenCalled();
    expect(mockEmitDelta).toHaveBeenCalledTimes(1);
    expect(mockEmitDelta).toHaveBeenCalledWith('session-1', {
      type: 'error',
      message: 'Failed to deliver interactive response. Please try again.',
    });
  });

  it('returns false when there is no pending interactive request', () => {
    mockGetPendingInteractiveRequest.mockReturnValue(null);

    const handled = tryHandleAsInteractiveResponse('session-1', 'msg-1', 'response text');

    expect(handled).toBe(false);
    expect(mockEmitDelta).not.toHaveBeenCalled();
    expect(mockClearPendingInteractiveRequestIfMatches).not.toHaveBeenCalled();
  });
});
