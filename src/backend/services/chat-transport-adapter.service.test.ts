import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageState } from '@/shared/claude';
import { chatConnectionService } from './chat-connection.service';
import { chatTransportAdapterService } from './chat-transport-adapter.service';
import { messageStateService } from './message-state.service';
import { sessionRuntimeStoreService } from './session-runtime-store.service';

vi.mock('./chat-connection.service', () => ({
  chatConnectionService: {
    forwardToSession: vi.fn(),
  },
}));

describe('ChatTransportAdapterService', () => {
  const mockedChatConnectionService = vi.mocked(chatConnectionService);

  beforeEach(() => {
    mockedChatConnectionService.forwardToSession.mockClear();
    messageStateService.clearAllSessions();
    sessionRuntimeStoreService.clearAllSessions();
    chatTransportAdapterService.teardown();
  });

  it('forwards message state changes to the websocket transport', () => {
    chatTransportAdapterService.setup();

    messageStateService.createUserMessage('session-1', {
      id: 'msg-1',
      text: 'Hello',
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
      timestamp: new Date().toISOString(),
    });

    expect(mockedChatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
      type: 'message_state_changed',
      id: 'msg-1',
      newState: MessageState.ACCEPTED,
      queuePosition: 0,
      errorMessage: undefined,
      userMessage: expect.objectContaining({
        text: 'Hello',
      }),
    });
  });

  it('re-subscribes when listeners are cleared', () => {
    chatTransportAdapterService.setup();
    messageStateService.clearAllSessions();

    chatTransportAdapterService.setup();
    messageStateService.createUserMessage('session-1', {
      id: 'msg-2',
      text: 'Reconnected',
      settings: {
        selectedModel: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
      timestamp: new Date().toISOString(),
    });

    expect(mockedChatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
      type: 'message_state_changed',
      id: 'msg-2',
      newState: MessageState.ACCEPTED,
      queuePosition: 0,
      errorMessage: undefined,
      userMessage: expect.objectContaining({
        text: 'Reconnected',
      }),
    });
  });

  it('forwards session runtime updates to the websocket transport', () => {
    chatTransportAdapterService.setup();
    sessionRuntimeStoreService.markRunning('session-1');

    expect(mockedChatConnectionService.forwardToSession).toHaveBeenCalledWith('session-1', {
      type: 'session_runtime_updated',
      sessionRuntime: expect.objectContaining({
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
      }),
    });
  });
});
