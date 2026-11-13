import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageState } from '@/shared/acp-protocol';

const mocks = vi.hoisted(() => ({
  hasQueuedMessage: vi.fn(() => true),
  enqueue: vi.fn(),
  emitDelta: vi.fn(),
  rejectMessage: vi.fn(),
  removeQueuedMessage: vi.fn(() => true),
  holdMessageForAdmission: vi.fn(() => vi.fn()),
}));

vi.mock('@/backend/services/session/service/store/session-domain.service', () => ({
  sessionDomainService: {
    enqueue: mocks.enqueue,
    emitDelta: mocks.emitDelta,
    rejectMessage: mocks.rejectMessage,
  },
}));

import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/delivery/session-background-delivery.service';
import { createQueueMessageHandler } from './queue-message.handler';

describe('createQueueMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits durable human follow-up before acknowledgement and dispatch, excluding rejected input', async () => {
    let release!: () => void;
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const humanMessageAccepted = vi.fn(() => saved);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      humanMessageAccepted,
      tryDispatchNextMessage: dispatch,
    });
    mocks.enqueue.mockReturnValue({ position: 0 });
    const outcome = handler(
      { sessionId: 'session-1', workingDir: '/tmp/work' },
      {
        type: 'queue_message',
        id: 'follow-up',
        text: 'thanks',
      }
    );
    expect(humanMessageAccepted).toHaveBeenCalledWith('session-1', expect.any(Date));
    expect(mocks.emitDelta).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    release();
    await outcome;
    expect(dispatch).toHaveBeenCalledOnce();
    mocks.enqueue.mockReturnValue({ error: 'Queue full' });
    await handler(
      { sessionId: 'session-1', workingDir: '/tmp/work' },
      {
        type: 'queue_message',
        id: 'rejected',
        text: 'more work',
      }
    );
    expect(humanMessageAccepted).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects and removes the queued message if follow-up persistence fails', async () => {
    mocks.enqueue.mockReturnValue({ position: 0 });
    const dispatch = vi.fn();
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      humanMessageAccepted: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      tryDispatchNextMessage: dispatch,
    });
    await handler(
      { sessionId: 'session-1', workingDir: '/tmp/work' },
      {
        type: 'queue_message',
        id: 'follow-up',
        text: 'continue',
      }
    );
    expect(mocks.removeQueuedMessage).toHaveBeenCalledWith('session-1', 'follow-up', {
      expectedMessage: expect.objectContaining({ id: 'follow-up' }),
    });
    expect(mocks.rejectMessage).toHaveBeenCalledWith(
      'session-1',
      'follow-up',
      expect.stringContaining('Try again')
    );
    expect(mocks.emitDelta).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('emits rejected state for empty queue messages with an id', async () => {
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      tryDispatchNextMessage: vi.fn(),
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'queue_message',
      id: 'msg-1',
      text: '   ',
      attachments: [],
    } as never);

    expect(outcome).toEqual({ replies: [] });
    expect(mocks.rejectMessage).toHaveBeenCalledWith('session-1', 'msg-1', 'Empty message');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects queue messages without an id', async () => {
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      tryDispatchNextMessage: vi.fn(),
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'queue_message',
      text: 'hello',
    } as never);

    expect(outcome).toEqual({
      replies: [
        { type: 'error', error: { kind: 'queue_input_invalid', reason: 'Missing message id' } },
      ],
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects client messages that use the workspace notification id namespace', async () => {
    mocks.enqueue.mockReturnValue({ position: 0 });
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      tryDispatchNextMessage,
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'queue_message',
      id: 'workspace-notification-user-controlled',
      text: 'hello',
    } as never);

    expect(outcome).toEqual({ replies: [] });
    expect(mocks.rejectMessage).toHaveBeenCalledWith(
      'session-1',
      'workspace-notification-user-controlled',
      'Reserved message id'
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['the PR event id namespace', { id: 'pr-event-user-controlled' }],
    ['the backend-owned PR event source', { id: 'client-message', source: 'pr_event' }],
  ])('rejects client messages that use %s', async (_name, message) => {
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      tryDispatchNextMessage,
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'queue_message',
      text: 'hello',
      ...message,
    } as never);

    expect(outcome).toEqual({ replies: [] });
    expect(mocks.rejectMessage).toHaveBeenCalledWith(
      'session-1',
      message.id,
      'Reserved message id'
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('emits rejected state for queue messages with invalid attachments', async () => {
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      tryDispatchNextMessage,
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
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
    } as never);

    expect(outcome).toEqual({ replies: [] });
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
    const tryDispatchNextMessage = vi.fn();
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      tryDispatchNextMessage,
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'queue_message',
      id: 'msg-1',
      text: 'hello',
    } as never);

    expect(outcome).toEqual({ replies: [] });
    expect(mocks.rejectMessage).toHaveBeenCalledWith('session-1', 'msg-1', 'Queue full');
    expect(tryDispatchNextMessage).not.toHaveBeenCalled();
  });

  it('accepts queued message and dispatches next message', async () => {
    mocks.enqueue.mockReturnValue({ position: 2 });
    const tryDispatchNextMessage = vi.fn(async () => undefined);
    const handler = createQueueMessageHandler({
      domain: mocks,
      backgroundDelivery: sessionBackgroundDeliveryService,
      tryDispatchNextMessage,
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'queue_message',
      id: 'msg-1',
      text: 'hello',
      settings: {
        selectedModel: 'sonnet',
        reasoningEffort: 'medium',
        thinkingEnabled: true,
        planModeEnabled: false,
      },
    } as never);

    expect(outcome).toEqual({ replies: [] });
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
        domain: mocks,
        backgroundDelivery: sessionBackgroundDeliveryService,
        tryDispatchNextMessage: dispatch,
      })({ sessionId: 'session-1', workingDir: '/tmp' }, {
        type: 'queue_message',
        id: 'human',
        text: 'continue',
      } as never)
    ).resolves.toEqual({ replies: [] });
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
