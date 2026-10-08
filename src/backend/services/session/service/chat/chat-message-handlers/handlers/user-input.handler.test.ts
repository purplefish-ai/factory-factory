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
  return { acpRuntimeManager, sessionService };
}

describe('createUserInputHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores empty or whitespace-only content', () => {
    const deps = createDeps();
    const handler = createUserInputHandler(deps);
    const ws = { send: vi.fn() };

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'user_input', text: '   ' } as never,
    });

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'user_input' } as never,
    });

    expect(deps.sessionService.sendSessionMessage).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('forwards text input to active session', async () => {
    const deps = createDeps({ isSessionRunning: true });
    const handler = createUserInputHandler(deps);
    const ws = { send: vi.fn() };

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'user_input', text: 'hello' } as never,
    });

    await vi.waitFor(() => expect(deps.sessionService.sendSessionMessage).toHaveBeenCalled());
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledWith('session-1', 'hello');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('forwards structured content arrays to active session', async () => {
    const deps = createDeps({ isSessionRunning: true });
    const handler = createUserInputHandler(deps);
    const ws = { send: vi.fn() };
    const content = [{ type: 'text', text: 'from array' }];

    void handler({
      ws: ws as never,
      sessionId: 'session-2',
      workingDir: '/tmp/work',
      message: { type: 'user_input', content } as never,
    });

    await vi.waitFor(() => expect(deps.sessionService.sendSessionMessage).toHaveBeenCalled());
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledWith('session-2', content);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('returns websocket error when no active session exists', () => {
    const deps = createDeps({ isSessionRunning: false });
    const handler = createUserInputHandler(deps);
    const ws = { send: vi.fn() };

    void handler({
      ws: ws as never,
      sessionId: 'session-3',
      workingDir: '/tmp/work',
      message: { type: 'user_input', text: 'hello' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'No active session. Use queue_message to queue messages.',
      })
    );
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
  const context = { ws: { send: vi.fn() } as never, sessionId: 'session-1', workingDir: '/tmp' };
  try {
    const first = handler({ ...context, message: { type: 'user_input', text: 'first' } as never });
    await handler({ ...context, message: { type: 'user_input', text: 'second' } as never });
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
      Promise.resolve(
        createUserInputHandler(deps)({
          ws: { send: vi.fn() } as never,
          sessionId: 'session-1',
          workingDir: '/tmp',
          message: { type: 'user_input', text: 'human' } as never,
        })
      )
    ).resolves.toBeUndefined();
    expect(deps.sessionService.sendSessionMessage).toHaveBeenCalledWith('session-1', 'human');
  } finally {
    resume.mockRestore();
  }
});
