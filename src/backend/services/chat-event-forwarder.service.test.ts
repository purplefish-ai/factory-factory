import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeClient } from '../claude/index';
import { interceptorRegistry } from '../interceptors';
import { chatConnectionService } from './chat-connection.service';
import { chatEventForwarderService } from './chat-event-forwarder.service';
import { messageStateService } from './message-state.service';
import { sessionFileLogger } from './session-file-logger.service';

vi.mock('./chat-connection.service', () => ({
  chatConnectionService: {
    forwardToSession: vi.fn(),
    values: vi.fn(() => []),
  },
}));

vi.mock('./message-state.service', () => ({
  messageStateService: {
    allocateOrder: vi.fn(() => 1),
    storeEvent: vi.fn(),
    clearSession: vi.fn(),
  },
}));

vi.mock('./session-file-logger.service', () => ({
  sessionFileLogger: {
    log: vi.fn(),
  },
}));

vi.mock('./workspace-activity.service', () => ({
  workspaceActivityService: {
    on: vi.fn(),
    markSessionRunning: vi.fn(),
    markSessionIdle: vi.fn(),
  },
}));

vi.mock('./session-runtime-store.service', () => ({
  sessionRuntimeStoreService: {
    syncFromClient: vi.fn(),
    markIdle: vi.fn(),
    markProcessExit: vi.fn(),
  },
}));

vi.mock('./slash-command-cache.service', () => ({
  slashCommandCacheService: {
    setCachedCommands: vi.fn(),
  },
}));

vi.mock('../interceptors', () => ({
  interceptorRegistry: {
    notifyToolStart: vi.fn(),
    notifyToolComplete: vi.fn(),
  },
}));

class TestClient extends EventEmitter {
  getInitializeResponse() {
    return null;
  }

  isRunning() {
    return true;
  }

  isWorking() {
    return false;
  }
}

describe('chatEventForwarderService assistant message forwarding', () => {
  const mockedChatConnectionService = vi.mocked(chatConnectionService);
  const mockedMessageStateService = vi.mocked(messageStateService);
  const mockedSessionFileLogger = vi.mocked(sessionFileLogger);
  const mockedInterceptorRegistry = vi.mocked(interceptorRegistry);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards assistant messages with text and preserves mixed content blocks', () => {
    mockedMessageStateService.allocateOrder.mockReturnValue(77);

    const sessionId = 'session-assistant-text';
    const client = new TestClient();

    chatEventForwarderService.setupClientEvents(
      sessionId,
      client as unknown as ClaudeClient,
      { workspaceId: 'workspace-1', workingDir: '/tmp/workspace' },
      vi.fn(async () => undefined)
    );

    client.emit('message', {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'text', text: 'Aha! Found the issue.' },
        ],
      },
    });

    const mixedAssistantMessage = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'text', text: 'Aha! Found the issue.' },
        ],
      },
    };
    const expectedWsMessage = {
      type: 'claude_message',
      data: mixedAssistantMessage,
      order: 77,
    };

    expect(mockedMessageStateService.storeEvent).toHaveBeenCalledWith(sessionId, expectedWsMessage);
    expect(mockedChatConnectionService.forwardToSession).toHaveBeenCalledWith(
      sessionId,
      expectedWsMessage
    );
    expect(mockedInterceptorRegistry.notifyToolComplete).not.toHaveBeenCalled();
  });

  it('skips assistant messages without text blocks', () => {
    const sessionId = 'session-assistant-no-text';
    const client = new TestClient();

    chatEventForwarderService.setupClientEvents(
      sessionId,
      client as unknown as ClaudeClient,
      { workspaceId: 'workspace-2', workingDir: '/tmp/workspace' },
      vi.fn(async () => undefined)
    );

    client.emit('message', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: 'b.ts' } }],
      },
    });

    expect(mockedMessageStateService.storeEvent).not.toHaveBeenCalled();
    expect(mockedChatConnectionService.forwardToSession).not.toHaveBeenCalled();
    expect(mockedSessionFileLogger.log).toHaveBeenCalledWith(
      sessionId,
      'INFO',
      expect.objectContaining({
        action: 'skipped_message',
        reason: 'assistant_no_text_content',
      })
    );
  });
});
