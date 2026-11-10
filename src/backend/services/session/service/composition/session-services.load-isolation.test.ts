import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import {
  SessionDomainService,
  sessionDomainService,
} from '@/backend/services/session/service/session-domain.service';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createSessionLoadService } from './session-services';

const { loadCodex, loadClaude } = vi.hoisted(() => ({ loadCodex: vi.fn(), loadClaude: vi.fn() }));
vi.mock('@/backend/services/session/service/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: { loadSessionHistory: loadCodex },
}));
vi.mock('@/backend/services/session/service/data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: { loadSessionHistory: loadClaude },
}));

function createLoad(domain: SessionDomainService) {
  return createSessionLoadService({
    domain,
    config: {
      getSessionConfigProjection: async () => ({
        currentProjection: () => ({
          capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
          configOptions: [],
        }),
      }),
    },
    hydrateLifecycleEvents: () => Promise.resolve(),
    getRuntimeSnapshot: (id) => domain.getRuntimeSnapshot(id),
    tryDispatchNextMessage: () => Promise.resolve(),
  });
}
const loaded = (text: string) => ({
  status: 'loaded',
  filePath: '/tmp/provider-history.jsonl',
  history: [{ type: 'user', uuid: text, timestamp: '2026-10-27T00:00:00Z', content: text }],
});

describe('session load history domain binding', () => {
  beforeEach(() => {
    sessionDomainService.clearAllSessions();
    const forbidden = () => {
      throw new Error('History hydration crossed into the global domain');
    };
    for (const method of [
      'getTranscriptSnapshot',
      'isHistoryHydrated',
      'createProviderHistoryFence',
      'getHistoryHydrationSource',
      'markHistoryHydrated',
      'clearHistoryRetryCooldown',
      'canAttemptHistoryHydration',
      'setHistoryRetryAt',
      'replaceTranscript',
      'prepareLoad',
    ] as const) {
      vi.spyOn(sessionDomainService, method).mockImplementation(forbidden);
    }
  });
  afterEach(() => {
    sessionDomainService.clearAllSessions();
    vi.restoreAllMocks();
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'hydrates and replays %s history through each owning domain and hydration cache',
    async (provider) => {
      vi.spyOn(agentSessionAccessor, 'findById').mockResolvedValue(
        unsafeCoerce({
          provider,
          providerSessionId: 'same-provider-id',
          providerMetadata: null,
          status: 'IDLE',
          workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
        })
      );
      const loadHistory = provider === 'CLAUDE' ? loadClaude : loadCodex;
      loadHistory
        .mockResolvedValueOnce(loaded('First graph'))
        .mockResolvedValueOnce(loaded('Second graph'));
      const first = new SessionDomainService();
      const second = new SessionDomainService();
      const firstLoad = createLoad(first);
      const secondLoad = createLoad(second);
      const firstPrepared = await firstLoad.prepareLoad({ sessionId: 'shared-session' });
      if (firstPrepared.status !== 'ready') {
        throw new Error('Expected ready first load');
      }
      expect(firstLoad.captureReplay(firstPrepared).replayEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'message_state_changed',
            userMessage: expect.objectContaining({ text: 'First graph' }),
          }),
        ])
      );
      expect(first.getHistoryHydrationSource('shared-session')).toBe('jsonl');
      expect(second.isHistoryHydrated('shared-session')).toBe(false);

      const secondPrepared = await secondLoad.prepareLoad({ sessionId: 'shared-session' });
      if (secondPrepared.status !== 'ready') {
        throw new Error('Expected ready second load');
      }
      expect(secondLoad.captureReplay(secondPrepared).replayEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'message_state_changed',
            userMessage: expect.objectContaining({ text: 'Second graph' }),
          }),
        ])
      );
      expect(first.getTranscriptSnapshot('shared-session').map((message) => message.text)).toEqual([
        'First graph',
      ]);
      expect(second.getHistoryHydrationSource('shared-session')).toBe('jsonl');
      expect(loadHistory).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps an unavailable-history retry cooldown local to the requesting load domain', async () => {
    vi.spyOn(agentSessionAccessor, 'findById').mockResolvedValue(
      unsafeCoerce({
        provider: 'CODEX',
        providerSessionId: 'same-provider-id',
        providerMetadata: null,
        status: 'IDLE',
        workspace: { status: 'READY', worktreePath: '/tmp/worktree' },
      })
    );
    loadCodex
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce(loaded('Available elsewhere'));
    const first = new SessionDomainService();
    const second = new SessionDomainService();
    await createLoad(first).prepareLoad({ sessionId: 'shared-session' });
    expect(first.canAttemptHistoryHydration('shared-session')).toBe(false);
    expect(second.canAttemptHistoryHydration('shared-session')).toBe(true);
    const secondLoad = createLoad(second);
    const prepared = await secondLoad.prepareLoad({ sessionId: 'shared-session' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready second load');
    }
    expect(secondLoad.captureReplay(prepared).replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message_state_changed',
          userMessage: expect.objectContaining({ text: 'Available elsewhere' }),
        }),
      ])
    );
    expect(loadCodex).toHaveBeenCalledTimes(2);
  });
});
