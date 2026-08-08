import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { mockSessionDataService, mockSessionEventBus, mockVoiceNarrationService } = vi.hoisted(
  () => ({
    mockSessionDataService: {
      findAgentSessionsByWorkspaceId: vi.fn(),
    },
    mockSessionEventBus: {
      publishToAllClients: vi.fn(),
    },
    mockVoiceNarrationService: {
      hasActiveConnection: vi.fn(),
    },
  })
);

vi.mock('@/backend/services/session/service/data/session-data.service', () => ({
  sessionDataService: mockSessionDataService,
}));

vi.mock('@/backend/services/session/service/session-event-bus', () => ({
  sessionEventBus: mockSessionEventBus,
}));

vi.mock('@/backend/services/session/service/voice/voice-narration.service', () => ({
  voiceNarrationService: mockVoiceNarrationService,
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: {
    getPendingInteractiveRequest: vi.fn(),
    clearPendingInteractiveRequest: vi.fn(),
    clearPendingInteractiveRequestIfMatches: vi.fn(),
    getAllPendingRequests: vi.fn(),
  },
}));

import {
  chatEventForwarderService,
  VOICE_ACTIVE_CHECK_TIMEOUT_MS,
} from './chat-event-forwarder.service';

type RequestNotificationHandler = (data: {
  workspaceId: string;
  workspaceName: string;
  sessionCount: number;
  finishedAt: Date;
}) => void;

function baseData(overrides: Partial<Parameters<RequestNotificationHandler>[0]> = {}) {
  return {
    workspaceId: 'workspace-1',
    workspaceName: 'My Workspace',
    sessionCount: 1,
    finishedAt: new Date('2026-08-07T00:00:00.000Z'),
    ...overrides,
  };
}

describe('chatEventForwarderService workspace notifications', () => {
  let handler: RequestNotificationHandler;

  beforeAll(() => {
    chatEventForwarderService.configure({
      workspace: {
        markSessionRunning: vi.fn(),
        markSessionIdle: vi.fn(),
        on: (_event, listener) => {
          handler = listener;
        },
      },
    });
    chatEventForwarderService.setupWorkspaceNotifications();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('publishes the notification when no session has an active voice connection', async () => {
    mockSessionDataService.findAgentSessionsByWorkspaceId.mockResolvedValue([{ id: 'session-1' }]);
    mockVoiceNarrationService.hasActiveConnection.mockReturnValue(false);

    handler(baseData());

    await vi.waitFor(() => {
      expect(mockSessionEventBus.publishToAllClients).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workspace_notification_request',
          workspaceId: 'workspace-1',
        })
      );
    });
  });

  it('suppresses the notification when a session has an active voice connection', async () => {
    mockSessionDataService.findAgentSessionsByWorkspaceId.mockResolvedValue([
      { id: 'session-1' },
      { id: 'session-2' },
    ]);
    mockVoiceNarrationService.hasActiveConnection.mockImplementation(
      (sessionId: string) => sessionId === 'session-2'
    );

    handler(baseData());

    await vi.waitFor(() => {
      expect(mockVoiceNarrationService.hasActiveConnection).toHaveBeenCalledWith('session-2');
    });
    expect(mockSessionEventBus.publishToAllClients).not.toHaveBeenCalled();
  });

  it('fails open and publishes when the session lookup rejects', async () => {
    mockSessionDataService.findAgentSessionsByWorkspaceId.mockRejectedValue(
      new Error('db unavailable')
    );

    handler(baseData());

    await vi.waitFor(() => {
      expect(mockSessionEventBus.publishToAllClients).toHaveBeenCalled();
    });
  });

  it('fails open and publishes when the session lookup stalls past the timeout', async () => {
    vi.useFakeTimers();
    mockSessionDataService.findAgentSessionsByWorkspaceId.mockReturnValue(
      new Promise(() => {
        // Never resolves — simulates a stalled DB lookup.
      })
    );

    handler(baseData());

    await vi.advanceTimersByTimeAsync(VOICE_ACTIVE_CHECK_TIMEOUT_MS);

    expect(mockSessionEventBus.publishToAllClients).toHaveBeenCalled();
  });

  it('keeps processing later notifications after an earlier publish fails', async () => {
    mockSessionDataService.findAgentSessionsByWorkspaceId.mockResolvedValue([]);
    mockSessionEventBus.publishToAllClients.mockImplementationOnce(() => {
      throw new Error('broadcast failed');
    });

    handler(baseData({ workspaceId: 'workspace-1' }));
    handler(baseData({ workspaceId: 'workspace-2' }));

    await vi.waitFor(() => {
      expect(mockSessionEventBus.publishToAllClients).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'workspace-2' })
      );
    });
  });
});
