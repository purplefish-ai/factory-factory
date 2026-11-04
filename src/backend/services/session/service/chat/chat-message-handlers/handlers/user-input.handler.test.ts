import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionCommandPromptService,
  SessionCommandRuntimeManager,
} from '@/backend/services/session/service/chat/session-command.types';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { ChatMessageSchema } from '@/shared/websocket';
import { createUserInputHandler } from './user-input.handler';

function pendingInput() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createDeps(options?: { isSessionRunning?: boolean }) {
  const acpRuntimeManager: SessionCommandRuntimeManager = {
    isSessionRunning: vi.fn(() => options?.isSessionRunning ?? false),
  };
  const sessionService: SessionCommandPromptService = {
    sendSessionMessage: vi.fn(async () => undefined),
  };
  return {
    acpRuntimeManager,
    sessionService,
    backgroundDelivery: sessionBackgroundDeliveryService,
  };
}
const context = { sessionId: 'session-1', workingDir: '/tmp/work' };

it('reports a late provider failure with original content after input submission completes', async () => {
  let fail!: (error: Error) => void;
  const providerTurn = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  const deps = createDeps({ isSessionRunning: true });
  vi.mocked(deps.sessionService.sendSessionMessage).mockReturnValue(providerTurn);
  const onAsyncOutcome = vi.fn();
  const handler = createUserInputHandler(deps);
  const content = [
    { type: 'text', text: 'recover me' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ];
  expect(await handler({ ...context, onAsyncOutcome }, { type: 'user_input', content })).toEqual({
    replies: [],
  });
  expect(onAsyncOutcome).not.toHaveBeenCalled();
  const cause = new Error('provider disconnected');
  fail(cause);
  await vi.waitFor(() =>
    expect(onAsyncOutcome).toHaveBeenCalledExactlyOnceWith({
      replies: [
        {
          type: 'error',
          error: {
            kind: 'user_input_failed',
            sessionId: 'session-1',
            content,
            cause,
          },
        },
      ],
    })
  );
  expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'contains failures from the recovery reporter (async: %s)',
  async (asyncFailure) => {
    const deps = createDeps({ isSessionRunning: true });
    vi.mocked(deps.sessionService.sendSessionMessage).mockRejectedValue(
      new Error('provider failed')
    );
    const onAsyncOutcome = vi.fn(() => {
      if (asyncFailure) {
        return Promise.reject(new Error('report failed'));
      }
      throw new Error('report failed');
    });
    expect(
      await createUserInputHandler(deps)(
        { ...context, onAsyncOutcome },
        {
          type: 'user_input',
          text: 'recover',
        }
      )
    ).toEqual({ replies: [] });
    await vi.waitFor(() => expect(onAsyncOutcome).toHaveBeenCalledOnce());
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledTimes(1);
  }
);

describe('createUserInputHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { malformed: null },
    { malformed: { type: 'image' } },
    {
      malformed: {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'bad%' },
      },
    },
    { malformed: { type: 'unknown' } },
    { malformed: { type: 'thinking', thinking: 'unsupported human input' } },
    { malformed: { type: 'tool_use', id: 'tool', name: 'unsupported', input: {} } },
    { malformed: { type: 'tool_result', tool_use_id: 'tool', content: 'unsupported' } },
    {
      malformed: {
        type: 'tool_result',
        tool_use_id: 'tool',
        content: [{ type: 'image', source: null }],
      },
    },
  ])('rejects malformed direct content before durable admission: %j', async ({ malformed }) => {
    const deps = createDeps({ isSessionRunning: true });
    const humanMessageAccepted = vi.fn().mockResolvedValue(undefined);
    const handler = createUserInputHandler({ ...deps, humanMessageAccepted });
    const message = ChatMessageSchema.parse({
      type: 'user_input',
      content: [{ type: 'text', text: 'keep' }, malformed],
    });
    if (message.type !== 'user_input') {
      throw new Error('Expected direct input');
    }
    expect(await handler(context, message)).toMatchObject({
      replies: [
        {
          type: 'error',
          error: { kind: 'user_input_failed', sessionId: 'session-1', content: message.content },
        },
      ],
    });
    expect(humanMessageAccepted).not.toHaveBeenCalled();
    expect(deps.sessionService.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('reopens on direct accepted input but not input without a running session', async () => {
    const humanMessageAccepted = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({ isSessionRunning: true });
    await createUserInputHandler({ ...deps, humanMessageAccepted })(context, {
      type: 'user_input',
      text: 'continue',
    });
    expect(humanMessageAccepted).toHaveBeenCalledWith('session-1', expect.any(Date));
    await createUserInputHandler({ ...createDeps(), humanMessageAccepted })(context, {
      type: 'user_input',
      text: 'continue',
    });
    expect(humanMessageAccepted).toHaveBeenCalledTimes(1);
  });

  it('ignores empty or whitespace-only content', async () => {
    const deps = createDeps();
    const handler = createUserInputHandler(deps);
    expect(await handler(context, { type: 'user_input', text: '   ' })).toEqual({ replies: [] });
    expect(await handler(context, { type: 'user_input' })).toEqual({ replies: [] });
    expect(deps.sessionService.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('forwards text input to active session', async () => {
    const deps = createDeps({ isSessionRunning: true });
    const handler = createUserInputHandler(deps);
    expect(await handler(context, { type: 'user_input', text: 'hello' })).toEqual({ replies: [] });
    await vi.waitFor(() => expect(deps.sessionService.sendSessionMessage).toHaveBeenCalled());
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledWith('session-1', 'hello');
  });

  it('forwards structured content arrays to active session', async () => {
    const deps = createDeps({ isSessionRunning: true });
    const handler = createUserInputHandler(deps);
    const content = [{ type: 'text', text: 'from array' }];
    expect(
      await handler({ ...context, sessionId: 'session-2' }, { type: 'user_input', content })
    ).toEqual({ replies: [] });
    await vi.waitFor(() => expect(deps.sessionService.sendSessionMessage).toHaveBeenCalled());
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledWith('session-2', content);
  });

  it('forwards a validated image-only direct message', async () => {
    const deps = createDeps({ isSessionRunning: true });
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ];
    expect(await createUserInputHandler(deps)(context, { type: 'user_input', content })).toEqual({
      replies: [],
    });
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledWith('session-1', content);
  });

  it('returns a typed requester error when no active session exists', async () => {
    const deps = createDeps({ isSessionRunning: false });
    expect(
      await createUserInputHandler(deps)(
        { ...context, sessionId: 'session-3' },
        { type: 'user_input', text: 'hello' }
      )
    ).toEqual({
      replies: [{ type: 'error', error: { kind: 'no_active_session' } }],
    });
    expect(deps.sessionService.sendSessionMessage).not.toHaveBeenCalled();
  });
});

it('sends concurrent human input in arrival order while delivery resume is pending', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resume = vi
    .spyOn(sessionBackgroundDeliveryService, 'userResume')
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce();
  const deps = createDeps({ isSessionRunning: true });
  const handler = createUserInputHandler(deps);
  try {
    const first = handler(context, { type: 'user_input', text: 'first' });
    await handler(context, { type: 'user_input', text: 'second' });
    expect(deps.sessionService.sendSessionMessage).toHaveBeenNthCalledWith(1, 'session-1', 'first');
    expect(deps.sessionService.sendSessionMessage).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'second'
    );
    release();
    await first;
  } finally {
    release();
    resume.mockRestore();
  }
});

it('sends human input when delivery resume persistence rejects', async () => {
  const resume = vi
    .spyOn(sessionBackgroundDeliveryService, 'userResume')
    .mockRejectedValue(new Error('database unavailable'));
  const deps = createDeps({ isSessionRunning: true });
  try {
    await expect(
      Promise.resolve(createUserInputHandler(deps)(context, { type: 'user_input', text: 'human' }))
    ).resolves.toEqual({ replies: [] });
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledWith('session-1', 'human');
  } finally {
    resume.mockRestore();
  }
});

it('returns recoverable original content when human admission fails', async () => {
  const cause = new Error('database unavailable');
  const deps = createDeps({ isSessionRunning: true });
  const content = [{ type: 'text' as const, text: 'keep this draft' }];
  const handler = createUserInputHandler({
    ...deps,
    humanMessageAccepted: vi.fn().mockRejectedValue(cause),
  });

  await expect(Promise.resolve(handler(context, { type: 'user_input', content }))).resolves.toEqual(
    {
      replies: [
        {
          type: 'error',
          error: { kind: 'user_input_failed', sessionId: 'session-1', content, cause },
        },
      ],
    }
  );
  expect(deps.sessionService.sendSessionMessage).not.toHaveBeenCalled();
});

it('serializes durable admission and submission without awaiting a full provider turn', async () => {
  const admission = pendingInput();
  const providerTurn = pendingInput();
  const deps = createDeps({ isSessionRunning: true });
  vi.mocked(deps.sessionService.sendSessionMessage).mockReturnValueOnce(providerTurn.promise);
  const humanMessageAccepted = vi
    .fn()
    .mockReturnValueOnce(admission.promise)
    .mockResolvedValue(undefined);
  const handler = createUserInputHandler({ ...deps, humanMessageAccepted });

  const first = handler(context, { type: 'user_input', text: 'first' });
  const second = handler(context, { type: 'user_input', text: 'second' });
  await Promise.resolve();
  expect(humanMessageAccepted).toHaveBeenCalledTimes(1);
  expect(deps.sessionService.sendSessionMessage).not.toHaveBeenCalled();

  admission.resolve();
  await Promise.all([first, second]);
  expect(deps.sessionService.sendSessionMessage).toHaveBeenNthCalledWith(1, 'session-1', 'first');
  expect(deps.sessionService.sendSessionMessage).toHaveBeenNthCalledWith(2, 'session-1', 'second');
  providerTurn.resolve();
});

it('rejects inputs captured before stop even if the session is running again after admission', async () => {
  const admission = pendingInput();
  let current = true;
  const deps = createDeps({ isSessionRunning: true });
  const handler = createUserInputHandler({
    ...deps,
    humanMessageAccepted: vi
      .fn()
      .mockReturnValueOnce(admission.promise)
      .mockResolvedValue(undefined),
    backgroundDelivery: {
      captureResumeGuard: () => () => current,
      userResume: vi.fn().mockResolvedValue(undefined),
    },
  });
  const first = handler(context, { type: 'user_input', text: 'before stop' });
  const second = handler(context, { type: 'user_input', text: 'also before stop' });
  await Promise.resolve();
  current = false;
  admission.resolve();

  for (const outcome of await Promise.all([first, second])) {
    expect(outcome).toMatchObject({
      replies: [{ type: 'error', error: { kind: 'user_input_failed' } }],
    });
  }
  expect(deps.sessionService.sendSessionMessage).not.toHaveBeenCalled();
});
