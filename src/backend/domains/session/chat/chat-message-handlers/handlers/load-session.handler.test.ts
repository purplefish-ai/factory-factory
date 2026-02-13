import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHydrateKey } from '@/backend/domains/session/store/session-hydrate-key';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
  getChatBarCapabilities: vi.fn(),
  tryHydrateCodexTranscript: vi.fn(),
  subscribe: vi.fn(),
  emitDelta: vi.fn(),
  setHydratedTranscript: vi.fn(),
  consumeInitialMessage: vi.fn(),
  getCachedCommands: vi.fn(),
  tryDispatchNextMessage: vi.fn(),
}));

vi.mock('@/backend/resource_accessors/agent-session.accessor', () => ({
  agentSessionAccessor: {
    findById: mocks.findById,
  },
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: {
    getRuntimeSnapshot: mocks.getRuntimeSnapshot,
    getChatBarCapabilities: mocks.getChatBarCapabilities,
    tryHydrateCodexTranscript: mocks.tryHydrateCodexTranscript,
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    subscribe: mocks.subscribe,
    emitDelta: mocks.emitDelta,
    setHydratedTranscript: mocks.setHydratedTranscript,
    consumeInitialMessage: mocks.consumeInitialMessage,
  },
}));

vi.mock('@/backend/domains/session/store/slash-command-cache.service', () => ({
  slashCommandCacheService: {
    getCachedCommands: mocks.getCachedCommands,
  },
}));

import { createLoadSessionHandler } from './load-session.handler';

describe('createLoadSessionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-02-13T00:00:00.000Z',
    });
    mocks.getChatBarCapabilities.mockResolvedValue({
      provider: 'CODEX',
      model: { enabled: false, options: [] },
      reasoning: { enabled: false, options: [] },
      thinking: { enabled: false },
      planMode: { enabled: true },
      attachments: { enabled: false, kinds: [] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    });
    mocks.getCachedCommands.mockResolvedValue(null);
  });

  it('hydrates CODEX transcript from thread/read before subscribe replay', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      workspace: { worktreePath: '/tmp/worktree' },
      claudeSessionId: null,
      claudeProjectPath: null,
    });
    mocks.tryHydrateCodexTranscript.mockResolvedValue([
      {
        id: 'codex-turn-1-item-1',
        source: 'user',
        text: 'hello',
        timestamp: '2026-02-13T00:00:00.000Z',
        order: 0,
      },
    ]);

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session', loadRequestId: 'load-1' } as never,
    });

    expect(mocks.tryHydrateCodexTranscript).toHaveBeenCalledWith('session-1');
    expect(mocks.setHydratedTranscript).toHaveBeenCalledWith(
      'session-1',
      expect.any(Array),
      expect.objectContaining({
        hydratedKey: buildHydrateKey({
          claudeSessionId: null,
          claudeProjectPath: null,
        }),
      })
    );
    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        claudeSessionId: null,
        claudeProjectPath: null,
        loadRequestId: 'load-1',
      })
    );
  });

  it('skips transcript replacement when no CODEX hydration data is available', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      workspace: { worktreePath: '/tmp/worktree' },
      claudeSessionId: null,
      claudeProjectPath: null,
    });
    mocks.tryHydrateCodexTranscript.mockResolvedValue(null);

    const handler = createLoadSessionHandler({
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.setHydratedTranscript).not.toHaveBeenCalled();
    expect(mocks.subscribe).toHaveBeenCalled();
  });
});
