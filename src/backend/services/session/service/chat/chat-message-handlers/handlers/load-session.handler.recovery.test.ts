import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/shared/acp-protocol';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  hydrateLifecycleEvents: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
  getChatBarCapabilities: vi.fn(),
  getSessionConfigOptionsWithFallback: vi.fn(),
  subscribe: vi.fn(),
  emitDelta: vi.fn(),
  getTranscriptSnapshot: vi.fn(),
  isHistoryHydrated: vi.fn(),
  getHistoryHydrationSource: vi.fn(),
  canAttemptHistoryHydration: vi.fn(),
  setHistoryRetryAt: vi.fn(),
  clearHistoryRetryCooldown: vi.fn(),
  markHistoryHydrated: vi.fn(),
  replaceTranscript: vi.fn(),
  consumeInitialMessage: vi.fn(),
  enqueue: vi.fn(),
  getCachedCommands: vi.fn(),
  loadClaudeSessionHistory: vi.fn(),
  loadCodexSessionHistory: vi.fn(),
  tryDispatchNextMessage: vi.fn(),
}));

vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: { findById: mocks.findById },
}));

vi.mock('@/backend/services/session/service/data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: { loadSessionHistory: mocks.loadClaudeSessionHistory },
}));

vi.mock('@/backend/services/session/service/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: { loadSessionHistory: mocks.loadCodexSessionHistory },
}));

vi.mock('@/backend/services/session/service/lifecycle/session-core-services', () => ({
  sessionLifecycleService: { getRuntimeSnapshot: mocks.getRuntimeSnapshot },
  sessionLifecycleEventService: { hydrate: mocks.hydrateLifecycleEvents },
  sessionConfigService: {
    getChatBarCapabilities: mocks.getChatBarCapabilities,
    getSessionConfigOptionsWithFallback: mocks.getSessionConfigOptionsWithFallback,
  },
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: {
    subscribe: mocks.subscribe,
    emitDelta: mocks.emitDelta,
    getTranscriptSnapshot: mocks.getTranscriptSnapshot,
    isHistoryHydrated: mocks.isHistoryHydrated,
    getHistoryHydrationSource: mocks.getHistoryHydrationSource,
    canAttemptHistoryHydration: mocks.canAttemptHistoryHydration,
    setHistoryRetryAt: mocks.setHistoryRetryAt,
    clearHistoryRetryCooldown: mocks.clearHistoryRetryCooldown,
    markHistoryHydrated: mocks.markHistoryHydrated,
    replaceTranscript: mocks.replaceTranscript,
    consumeInitialMessage: mocks.consumeInitialMessage,
    enqueue: mocks.enqueue,
  },
}));

vi.mock('@/backend/services/session/service/store/slash-command-cache.service', () => ({
  slashCommandCacheService: { getCachedCommands: mocks.getCachedCommands },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createLoadSessionHandler } from './load-session.handler';

function unmatchedToolCall(): ChatMessage {
  return {
    id: 'history-tool-1',
    source: 'agent',
    timestamp: '2026-08-20T10:00:00.000Z',
    order: 0,
    message: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call-interrupted',
          name: 'exec_command',
          input: { cmd: 'pnpm test' },
        },
      },
    },
  };
}

function matchingToolResult(): ChatMessage {
  return {
    id: 'history-tool-result-1',
    source: 'agent',
    timestamp: '2026-08-20T10:00:01.000Z',
    order: 1,
    message: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-interrupted',
            content: 'tests passed',
          },
        ],
      },
    },
  };
}

async function loadSession(): Promise<void> {
  const handler = createLoadSessionHandler({
    tryDispatchNextMessage: mocks.tryDispatchNextMessage,
    setManualDispatchResume: vi.fn(),
  });

  await handler({
    ws: { send: vi.fn() } as never,
    sessionId: 'session-crashed',
    workingDir: '/tmp/worktree',
    message: { type: 'load_session' } as never,
  });
}

describe('load session tool-call recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({
      provider: 'CODEX',
      status: 'IDLE',
      model: 'gpt-5.3-codex',
      providerSessionId: 'provider-session-1',
      providerMetadata: null,
      workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
    });
    mocks.isHistoryHydrated.mockReturnValue(true);
    mocks.getHistoryHydrationSource.mockReturnValue('jsonl');
    mocks.getTranscriptSnapshot.mockReturnValue([unmatchedToolCall()]);
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      updatedAt: '2026-08-20T10:01:00.000Z',
    });
    mocks.getChatBarCapabilities.mockResolvedValue({
      provider: 'CODEX',
      model: { enabled: false, options: [] },
      reasoning: { enabled: false, options: [] },
      thinking: { enabled: false },
      planMode: { enabled: true },
      attachments: { enabled: true, kinds: ['image', 'text'] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    });
    mocks.getSessionConfigOptionsWithFallback.mockResolvedValue([]);
    mocks.getCachedCommands.mockResolvedValue([]);
    mocks.consumeInitialMessage.mockReturnValue(null);
  });

  it('finalizes an unmatched historical tool call when loading a stopped session', async () => {
    await loadSession();

    expect(mocks.replaceTranscript).toHaveBeenCalledWith(
      'session-crashed',
      expect.arrayContaining([
        expect.objectContaining({
          source: 'agent',
          message: expect.objectContaining({
            type: 'user',
            message: expect.objectContaining({
              content: [
                expect.objectContaining({
                  type: 'tool_result',
                  tool_use_id: 'call-interrupted',
                  is_error: true,
                }),
              ],
            }),
          }),
        }),
      ])
    );
  });

  it('keeps an unmatched tool call pending while the session is running', async () => {
    mocks.getRuntimeSnapshot.mockReturnValue({
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: '2026-08-20T10:01:00.000Z',
    });

    await loadSession();

    expect(mocks.replaceTranscript).not.toHaveBeenCalled();
  });

  it('does not alter a stopped transcript whose tool call already completed', async () => {
    mocks.getTranscriptSnapshot.mockReturnValue([unmatchedToolCall(), matchingToolResult()]);

    await loadSession();

    expect(mocks.replaceTranscript).not.toHaveBeenCalled();
  });
});
