import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
  getChatBarCapabilities: vi.fn(),
  subscribe: vi.fn(),
  emitDelta: vi.fn(),
  getCachedCommands: vi.fn(),
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
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    subscribe: mocks.subscribe,
    emitDelta: mocks.emitDelta,
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

  it('subscribes with no Claude hydration context for CODEX session', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      workspace: { worktreePath: '/tmp/worktree' },
      claudeSessionId: null,
      claudeProjectPath: null,
    });

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session', loadRequestId: 'load-1' } as never,
    });

    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        claudeSessionId: null,
        claudeProjectPath: null,
        loadRequestId: 'load-1',
      })
    );
  });

  it('emits cached slash commands when available', async () => {
    mocks.findById.mockResolvedValue({
      provider: 'CLAUDE',
      workspace: { worktreePath: '/tmp/worktree' },
      claudeSessionId: null,
      claudeProjectPath: null,
    });
    mocks.getCachedCommands.mockResolvedValue([{ name: '/test', description: 'Test command' }]);

    const handler = createLoadSessionHandler();
    const ws = { send: vi.fn() } as unknown as { send: (payload: string) => void };
    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/worktree',
      message: { type: 'load_session' } as never,
    });

    expect(mocks.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'slash_commands',
      slashCommands: [{ name: '/test', description: 'Test command' }],
    });
  });
});
