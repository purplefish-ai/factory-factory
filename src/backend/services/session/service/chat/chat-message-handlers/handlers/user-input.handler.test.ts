import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatMessageHandlerPromptService,
  ChatMessageHandlerRuntimeManager,
} from '@/backend/services/session/service/chat/chat-message-handlers/types';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { createUserInputHandler } from './user-input.handler';

function createDeps(options?: { isSessionRunning?: boolean }) {
  const acpRuntimeManager: ChatMessageHandlerRuntimeManager = {
    isSessionRunning: vi.fn(() => options?.isSessionRunning ?? false),
  };
  const sessionService: ChatMessageHandlerPromptService = {
    sendSessionMessage: vi.fn(async () => undefined),
  };
  return {
    acpRuntimeManager,
    sessionService,
    backgroundDelivery: sessionBackgroundDeliveryService,
  };
}
const context = { sessionId: 'session-1', workingDir: '/tmp/work' };

describe('createUserInputHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
