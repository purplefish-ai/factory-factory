import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTranscriptSnapshot: vi.fn(),
  isSessionRunning: vi.fn(),
  sendSessionMessage: vi.fn(),
}));

vi.mock('@/backend/services/session/service/acp', () => ({
  acpRuntimeManager: {
    isSessionRunning: mocks.isSessionRunning,
  },
}));

vi.mock('@/backend/services/session/service/lifecycle/session-services', () => ({
  sessionService: {
    sendSessionMessage: mocks.sendSessionMessage,
  },
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: {
    getTranscriptSnapshot: mocks.getTranscriptSnapshot,
  },
}));

import { sessionInterceptorBridge } from './interceptor.bridge';

describe('sessionInterceptorBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps transcript entries into interceptor conversation history', () => {
    mocks.getTranscriptSnapshot.mockReturnValue([
      {
        source: 'user',
        text: 'plain user text',
        timestamp: '2026-02-27T00:00:00.000Z',
      },
      {
        source: 'assistant',
        timestamp: '2026-02-27T00:01:00.000Z',
        message: {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'chunk one' },
              { type: 'image', mimeType: 'image/png', data: 'abc' },
              { type: 'text', text: 'chunk two' },
            ],
          },
        },
      },
      {
        source: 'assistant',
        timestamp: '2026-02-27T00:02:00.000Z',
        message: {
          type: 'assistant',
          message: {
            content: 'single assistant string',
          },
        },
      },
      {
        source: 'assistant',
        timestamp: '2026-02-27T00:03:00.000Z',
        message: { type: 'tool' },
      },
    ]);

    expect(
      sessionInterceptorBridge.getSessionConversationHistory('session-1', '/tmp/work')
    ).toEqual([
      {
        type: 'user',
        content: 'plain user text',
        timestamp: '2026-02-27T00:00:00.000Z',
      },
      {
        type: 'assistant',
        content: 'chunk one\nchunk two',
        timestamp: '2026-02-27T00:01:00.000Z',
      },
      {
        type: 'assistant',
        content: 'single assistant string',
        timestamp: '2026-02-27T00:02:00.000Z',
      },
    ]);
  });
});
