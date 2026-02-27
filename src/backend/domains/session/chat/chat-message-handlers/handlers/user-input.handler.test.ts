import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageHandlerSessionService } from '@/backend/domains/session/chat/chat-message-handlers/types';
import { createUserInputHandler } from './user-input.handler';

function createDeps(overrides?: Partial<ChatMessageHandlerSessionService>) {
  const deps: ChatMessageHandlerSessionService = {
    isSessionRunning: vi.fn(() => false),
    sendSessionMessage: vi.fn(async () => undefined),
    respondToAcpPermission: vi.fn(),
    setSessionModel: vi.fn(async () => undefined),
    setSessionReasoningEffort: vi.fn(),
    getChatBarCapabilities: vi.fn(async () => ({})),
    ...overrides,
  };
  return deps;
}

describe('createUserInputHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores empty or whitespace-only content', () => {
    const sessionService = createDeps();
    const handler = createUserInputHandler({ sessionService });
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

    expect(sessionService.sendSessionMessage).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('forwards text input to active session', async () => {
    const sessionService = createDeps({ isSessionRunning: vi.fn(() => true) });
    const handler = createUserInputHandler({ sessionService });
    const ws = { send: vi.fn() };

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'user_input', text: 'hello' } as never,
    });

    await Promise.resolve();
    expect(sessionService.sendSessionMessage).toHaveBeenCalledWith('session-1', 'hello');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('forwards structured content arrays to active session', async () => {
    const sessionService = createDeps({ isSessionRunning: vi.fn(() => true) });
    const handler = createUserInputHandler({ sessionService });
    const ws = { send: vi.fn() };
    const content = [{ type: 'text', text: 'from array' }];

    void handler({
      ws: ws as never,
      sessionId: 'session-2',
      workingDir: '/tmp/work',
      message: { type: 'user_input', content } as never,
    });

    await Promise.resolve();
    expect(sessionService.sendSessionMessage).toHaveBeenCalledWith('session-2', content);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('returns websocket error when no active session exists', () => {
    const sessionService = createDeps({ isSessionRunning: vi.fn(() => false) });
    const handler = createUserInputHandler({ sessionService });
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
