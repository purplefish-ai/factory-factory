import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageState } from '@/shared/acp-protocol';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  emitDelta: vi.fn(),
  rejectMessage: vi.fn(),
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: {
    enqueue: mocks.enqueue,
    emitDelta: mocks.emitDelta,
    rejectMessage: mocks.rejectMessage,
  },
}));

import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { createQueueMessageHandler } from './queue-message.handler';

describe('createQueueMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits rejected state for empty queue messages with an id', async () => {
    const ws = { send: vi.fn() };
    const handler = createQueueMessageHandler({
      tryDispatchNextMessage: vi.fn(),
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'queue_message', id: 'msg-1', text: '   ', attachments: [] } as never,
    });

    expect(ws.send).not.toHaveBeenCalled();
    expect(mocks.rejectMessage).toHaveBeenCalledWith('session-1', 'msg-1', 'Empty message');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects queue messages without an id', async () => {
    const ws = { send: vi.fn() };
    const handler = createQueueMessageHandler({
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

  it('rejects client messages that use the workspace notification id namespace', async () => {
    mocks.enqueue.mockReturnValue({ position: 0 });
    const ws = { send: vi.fn() };
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
      tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: {
        type: 'queue_message',
        id: 'workspace-notification-user-controlled',
        text: 'hello',
      } as never,
    });

    expect(ws.send).not.toHaveBeenCalled();
    expect(mocks.rejectMessage).toHaveBeenCalledWith(
      'session-1',
      'workspace-notification-user-controlled',
      'Reserved message id'
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('emits rejected state for queue messages with invalid attachments', async () => {
    const ws = { send: vi.fn() };
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
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
        attachments: [
          {
            id: 'img-1',
            name: 'broken.png',
            type: 'image/png',
            size: 10,
            data: 'invalid base64 with spaces!',
          },
        ],
      } as never,
    });

    expect(ws.send).not.toHaveBeenCalled();
    expect(mocks.rejectMessage).toHaveBeenCalledWith(
      'session-1',
      'msg-1',
      'Attachment "broken.png" has invalid image data'
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('emits rejected state when enqueue fails', async () => {
    mocks.enqueue.mockReturnValue({ error: 'Queue full' });
    const ws = { send: vi.fn() };
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
      tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'queue_message', id: 'msg-1', text: 'hello' } as never,
    });

    expect(mocks.rejectMessage).toHaveBeenCalledWith('session-1', 'msg-1', 'Queue full');
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('accepts queued message and dispatches next message', async () => {
    mocks.enqueue.mockReturnValue({ position: 2 });
    const ws = { send: vi.fn() };
    const tryDispatchNextMessage = vi.fn(async () => undefined);
    const handler = createQueueMessageHandler({
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

it('acknowledges and dispatches human input when delivery resume fails', async () => {
  const resume = vi
    .spyOn(sessionBackgroundDeliveryService, 'userResume')
    .mockRejectedValue(new Error('database unavailable'));
  mocks.enqueue.mockReturnValue({ position: 0 });
  const dispatch = vi.fn();
  try {
    await expect(
      createQueueMessageHandler({
        tryDispatchNextMessage: dispatch,
        setManualDispatchResume: vi.fn(),
      })({
        ws: { send: vi.fn() } as never,
        sessionId: 'session-1',
        workingDir: '/tmp',
        message: { type: 'queue_message', id: 'human', text: 'continue' } as never,
      })
    ).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledWith('session-1', expect.any(Function));
    expect(mocks.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'human', newState: MessageState.ACCEPTED })
    );
    expect(dispatch).toHaveBeenCalledWith('session-1');
  } finally {
    resume.mockRestore();
  }
});
