import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatEventForwarderService } from './chat-event-forwarder.service';

const mockAppendClaudeEvent = vi.fn();
const mockEmitDelta = vi.fn();
const mockSetPendingInteractiveRequest = vi.fn();
const mockClearPendingInteractiveRequest = vi.fn();
const mockClearPendingInteractiveRequestIfMatches = vi.fn();
const mockGetPendingInteractiveRequest = vi.fn();
const mockGetAllPendingRequests = vi.fn();
const mockMarkRunning = vi.fn();
const mockMarkIdle = vi.fn();
const mockMarkWorkspaceRunning = vi.fn();
const mockMarkWorkspaceIdle = vi.fn();
const mockNotifyToolStart = vi.fn();
const mockNotifyToolComplete = vi.fn();
const mockSetCachedCommands = vi.fn();

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    appendClaudeEvent: (...args: unknown[]) => mockAppendClaudeEvent(...args),
    emitDelta: (...args: unknown[]) => mockEmitDelta(...args),
    setPendingInteractiveRequest: (...args: unknown[]) => mockSetPendingInteractiveRequest(...args),
    clearPendingInteractiveRequest: (...args: unknown[]) =>
      mockClearPendingInteractiveRequest(...args),
    clearPendingInteractiveRequestIfMatches: (...args: unknown[]) =>
      mockClearPendingInteractiveRequestIfMatches(...args),
    getPendingInteractiveRequest: (...args: unknown[]) => mockGetPendingInteractiveRequest(...args),
    getAllPendingRequests: (...args: unknown[]) => mockGetAllPendingRequests(...args),
    markRunning: (...args: unknown[]) => mockMarkRunning(...args),
    markIdle: (...args: unknown[]) => mockMarkIdle(...args),
  },
}));

vi.mock('@/backend/services/workspace-activity.service', () => ({
  workspaceActivityService: {
    on: vi.fn(),
    markSessionRunning: (...args: unknown[]) => mockMarkWorkspaceRunning(...args),
    markSessionIdle: (...args: unknown[]) => mockMarkWorkspaceIdle(...args),
  },
}));

vi.mock('@/backend/services/slash-command-cache.service', () => ({
  slashCommandCacheService: {
    setCachedCommands: (...args: unknown[]) => mockSetCachedCommands(...args),
  },
}));

vi.mock('@/backend/interceptors', () => ({
  interceptorRegistry: {
    notifyToolStart: (...args: unknown[]) => mockNotifyToolStart(...args),
    notifyToolComplete: (...args: unknown[]) => mockNotifyToolComplete(...args),
  },
}));

vi.mock('@/backend/services/session-file-logger.service', () => ({
  sessionFileLogger: {
    log: vi.fn(),
  },
}));

vi.mock('./chat-connection.service', () => ({
  chatConnectionService: {
    values: vi.fn(() => []),
  },
}));

vi.mock('@/backend/services/config.service', () => ({
  configService: {
    getDebugConfig: () => ({ chatWebSocket: false }),
  },
}));

class MockClaudeClient extends EventEmitter {
  private working = false;
  private running = true;

  getInitializeResponse(): null {
    return null;
  }

  isWorking(): boolean {
    return this.working;
  }

  isRunning(): boolean {
    return this.running;
  }

  setWorking(working: boolean): void {
    this.working = working;
  }
}

describe('ChatEventForwarderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not emit workspace idle when idle callback immediately re-dispatches work', async () => {
    const client = new MockClaudeClient();
    const onDispatchNextMessage = vi.fn(() => {
      client.setWorking(true);
      return Promise.resolve();
    });

    chatEventForwarderService.setupClientEvents(
      'session-idle-race',
      client as never,
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' },
      onDispatchNextMessage
    );

    client.emit('idle');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onDispatchNextMessage).toHaveBeenCalledTimes(1);
    expect(mockMarkWorkspaceIdle).not.toHaveBeenCalled();
    expect(mockMarkRunning).toHaveBeenCalledWith('session-idle-race');
  });

  it('forwards tool_use blocks from assistant message events during live streaming', () => {
    mockAppendClaudeEvent.mockReturnValue(41);

    const client = new MockClaudeClient();
    chatEventForwarderService.setupClientEvents(
      'session-tool-use-fallback',
      client as never,
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' },
      vi.fn(async () => {
        // no-op
      })
    );

    client.emit('message', {
      type: 'assistant',
      timestamp: '2026-02-08T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-123', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    });

    expect(mockAppendClaudeEvent).toHaveBeenCalledWith(
      'session-tool-use-fallback',
      expect.objectContaining({
        type: 'stream_event',
        event: expect.objectContaining({
          type: 'content_block_start',
          content_block: expect.objectContaining({
            type: 'tool_use',
            id: 'tool-123',
          }),
        }),
      })
    );

    expect(mockEmitDelta).toHaveBeenCalledWith(
      'session-tool-use-fallback',
      expect.objectContaining({
        type: 'claude_message',
        data: expect.objectContaining({
          type: 'stream_event',
          event: expect.objectContaining({
            type: 'content_block_start',
          }),
        }),
      })
    );
  });
});
