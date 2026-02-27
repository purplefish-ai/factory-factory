import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageState } from '@/shared/acp-protocol';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  emitDelta: vi.fn(),
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    enqueue: mocks.enqueue,
    emitDelta: mocks.emitDelta,
  },
}));

import { createQueueMessageHandler } from './queue-message.handler';

describe('createQueueMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects empty queue messages', async () => {
    const ws = { send: vi.fn() };
    const handler = createQueueMessageHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: vi.fn(),
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'queue_message', id: 'msg-1', text: '   ', attachments: [] } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Empty message' })
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects queue messages without an id', async () => {
    const ws = { send: vi.fn() };
    const handler = createQueueMessageHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: vi.fn(),
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'queue_message', text: 'hello' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Missing message id' })
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('emits rejected state when enqueue fails', async () => {
    mocks.enqueue.mockReturnValue({ error: 'Queue full' });
    const ws = { send: vi.fn() };
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'queue_message', id: 'msg-1', text: 'hello' } as never,
    });

    expect(mocks.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'message_state_changed',
      id: 'msg-1',
      newState: MessageState.REJECTED,
      errorMessage: 'Queue full',
    });
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('accepts queued message and dispatches next message', async () => {
    mocks.enqueue.mockReturnValue({ position: 2 });
    const ws = { send: vi.fn() };
    const tryDispatchNextMessage = vi.fn(async () => undefined);
    const handler = createQueueMessageHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: {
        type: 'queue_message',
        id: 'msg-1',
        text: 'hello',
        settings: {
          selectedModel: 'sonnet',
          reasoningEffort: 'medium',
          thinkingEnabled: true,
          planModeEnabled: false,
        },
      } as never,
    });

    expect(mocks.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'message_state_changed',
        id: 'msg-1',
        newState: MessageState.ACCEPTED,
        queuePosition: 2,
        userMessage: expect.objectContaining({
          text: 'hello',
          settings: expect.objectContaining({
            selectedModel: 'sonnet',
            reasoningEffort: 'medium',
          }),
        }),
      })
    );
    expect(tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
  });
});
