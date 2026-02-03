import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ClaudeClient } from '../../../claude/index';
import { SessionManager } from '../../../claude/index';
import { claudeSessionAccessor } from '../../../resource_accessors/claude-session.accessor';
import { chatEventForwarderService } from '../../chat-event-forwarder.service';
import { messageQueueService } from '../../message-queue.service';
import { messageStateService } from '../../message-state.service';
import { sessionService } from '../../session.service';
import { createGetHistoryHandler } from './get-history.handler';
import { createGetQueueHandler } from './get-queue.handler';
import { createListSessionsHandler } from './list-sessions.handler';
import { createLoadSessionHandler } from './load-session.handler';
import { createPermissionResponseHandler } from './permission-response.handler';
import { createQuestionResponseHandler } from './question-response.handler';
import { createQueueMessageHandler } from './queue-message.handler';
import { createRemoveQueuedMessageHandler } from './remove-queued-message.handler';
import { createRewindFilesHandler } from './rewind-files.handler';
import { createSetModelHandler } from './set-model.handler';
import { createSetThinkingBudgetHandler } from './set-thinking-budget.handler';
import { createStartHandler } from './start.handler';
import { createStopHandler } from './stop.handler';
import { createUserInputHandler } from './user-input.handler';

vi.mock('../../../claude/index', () => ({
  SessionManager: {
    listSessions: vi.fn(),
    getHistory: vi.fn(),
  },
}));

vi.mock('../../../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findById: vi.fn(),
  },
}));

vi.mock('../../chat-connection.service', () => ({
  chatConnectionService: {
    forwardToSession: vi.fn(),
  },
}));

vi.mock('../../chat-event-forwarder.service', () => ({
  chatEventForwarderService: {
    getPendingRequest: vi.fn(),
    clearPendingRequest: vi.fn(),
    clearPendingRequestIfMatches: vi.fn(),
  },
}));

vi.mock('../../event-compression.service', () => ({
  eventCompressionService: {
    compressWithStats: vi.fn(() => ({
      compressed: [],
      stats: { originalCount: 0, compressedCount: 0 },
    })),
    logCompressionStats: vi.fn(),
  },
}));

vi.mock('../../message-queue.service', () => ({
  messageQueueService: {
    enqueue: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../message-state.service', () => ({
  messageStateService: {
    allocateOrder: vi.fn(() => 1),
    computeSessionStatus: vi.fn(() => ({ messages: [], queue: [] })),
    createRejectedMessage: vi.fn(),
    createUserMessage: vi.fn(),
    getStoredEvents: vi.fn(() => []),
    loadFromHistory: vi.fn(),
    sendSnapshot: vi.fn(),
    updateState: vi.fn(),
  },
}));

vi.mock('../../session.service', () => ({
  sessionService: {
    getClient: vi.fn(),
    getSessionOptions: vi.fn(),
    stopClaudeSession: vi.fn(),
  },
}));

const deps = {
  getClientCreator: vi.fn(),
  tryDispatchNextMessage: vi.fn(),
};

function createWs() {
  return { send: vi.fn() } as unknown as WebSocket;
}

const mockedSessionManager = vi.mocked(SessionManager);
const mockedClaudeSessionAccessor = vi.mocked(claudeSessionAccessor);
const mockedChatEventForwarderService = vi.mocked(chatEventForwarderService);
const mockedMessageQueueService = vi.mocked(messageQueueService);
const mockedMessageStateService = vi.mocked(messageStateService);
const mockedSessionService = vi.mocked(sessionService);

describe('chat message handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list_sessions sends session list', async () => {
    const handler = createListSessionsHandler();
    const ws = createWs();

    (mockedSessionManager.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 's1' }]);

    await handler({ ws, sessionId: '', workingDir: '/tmp', message: { type: 'list_sessions' } });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'sessions', sessions: [{ id: 's1' }] })
    );
  });

  it('start sends error when client creator missing', async () => {
    const handler = createStartHandler({
      ...deps,
      getClientCreator: () => null,
    });
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'start' },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Client creator not configured' })
    );
  });

  it('user_input forwards to running client', () => {
    const sendMessage = vi.fn();
    mockedSessionService.getClient.mockReturnValue({
      isRunning: () => true,
      sendMessage,
    } as unknown as ClaudeClient);

    const handler = createUserInputHandler();
    const ws = createWs();

    handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'user_input', text: 'hi' },
    });

    expect(sendMessage).toHaveBeenCalledWith('hi');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('queue_message enqueues and dispatches', async () => {
    mockedMessageQueueService.enqueue.mockReturnValue({ position: 0 });

    const handler = createQueueMessageHandler({
      ...deps,
      tryDispatchNextMessage: vi.fn(),
    });
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'queue_message', id: 'msg-1', text: 'hello' },
    });

    expect(mockedMessageQueueService.enqueue).toHaveBeenCalled();
    expect(mockedMessageStateService.createRejectedMessage).not.toHaveBeenCalled();
  });

  it('remove_queued_message updates state when removed', () => {
    mockedMessageQueueService.remove.mockReturnValue(true);

    const handler = createRemoveQueuedMessageHandler();
    const ws = createWs();

    handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'remove_queued_message', messageId: 'msg-1' },
    });

    expect(mockedMessageStateService.updateState).toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('stop clears pending requests and notifies', async () => {
    const handler = createStopHandler();
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'stop' },
    });

    expect(mockedSessionService.stopClaudeSession).toHaveBeenCalledWith('session-1');
    expect(mockedChatEventForwarderService.clearPendingRequest).toHaveBeenCalledWith('session-1');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'stopped', dbSessionId: 'session-1' })
    );
  });

  it('get_history returns history when claude session exists', async () => {
    mockedSessionService.getClient.mockReturnValue({
      getClaudeSessionId: () => 'claude-1',
    } as unknown as ClaudeClient);
    (mockedSessionManager.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([{ role: 'user' }]);

    const handler = createGetHistoryHandler();
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'get_history' },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'history', dbSessionId: 'session-1', messages: [{ role: 'user' }] })
    );
  });

  it('load_session sends error when session missing', async () => {
    mockedClaudeSessionAccessor.findById.mockResolvedValue(null);

    const handler = createLoadSessionHandler();
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'load_session' },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Session not found' })
    );
  });

  it('get_queue sends snapshot', () => {
    mockedSessionService.getClient.mockReturnValue(undefined);
    const handler = createGetQueueHandler();

    handler({
      ws: createWs(),
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'get_queue' },
    });

    expect(mockedMessageStateService.sendSnapshot).toHaveBeenCalled();
  });

  it('question_response errors without client', () => {
    mockedSessionService.getClient.mockReturnValue(undefined);

    const handler = createQuestionResponseHandler();
    const ws = createWs();

    handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'question_response', requestId: 'req-1', answers: {} },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'No active client for session' })
    );
  });

  it('permission_response approves when allowed', () => {
    const approveInteractiveRequest = vi.fn();
    mockedSessionService.getClient.mockReturnValue({
      approveInteractiveRequest,
      denyInteractiveRequest: vi.fn(),
    } as unknown as ClaudeClient);

    const handler = createPermissionResponseHandler();
    const ws = createWs();

    handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'permission_response', requestId: 'req-1', allow: true },
    });

    expect(approveInteractiveRequest).toHaveBeenCalledWith('req-1');
  });

  it('set_model sends error without client', async () => {
    mockedSessionService.getClient.mockReturnValue(undefined);

    const handler = createSetModelHandler();
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'set_model', model: 'opus' },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'No active client for session' })
    );
  });

  it('set_thinking_budget sends error without client', async () => {
    mockedSessionService.getClient.mockReturnValue(undefined);

    const handler = createSetThinkingBudgetHandler();
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'set_thinking_budget', max_tokens: 1000 },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'No active client for session' })
    );
  });

  it('rewind_files returns error without client', async () => {
    mockedSessionService.getClient.mockReturnValue(undefined);

    const handler = createRewindFilesHandler();
    const ws = createWs();

    await handler({
      ws,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: { type: 'rewind_files', userMessageId: 'msg-1' },
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'rewind_files_error',
        userMessageId: 'msg-1',
        rewindError: 'No active client for session',
      })
    );
  });
});
