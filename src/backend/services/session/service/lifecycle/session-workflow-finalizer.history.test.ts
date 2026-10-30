import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { ChatMessage } from '@/shared/acp-protocol';
import { createLifecycleTestSession } from './session-lifecycle.test-helpers';
import { createProviderHistoryHydrator } from './session-provider-history-hydrator';
import { SessionWorkflowFinalizer } from './session-workflow-finalizer';

const { loadHistory } = vi.hoisted(() => ({ loadHistory: vi.fn() }));
vi.mock('@/backend/services/session/service/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: { loadSessionHistory: loadHistory },
}));
vi.mock('@/backend/services/session/service/data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: { loadSessionHistory: loadHistory },
}));

function setup(
  provider: 'CLAUDE' | 'CODEX' = 'CLAUDE',
  metadataOnly = false,
  observedEmpty = false
) {
  const session = createLifecycleTestSession({
    provider,
    workflow: 'ratchet',
    providerSessionId: metadataOnly ? null : 'provider-history',
    providerMetadata: { acpConfigSnapshot: { provider, providerSessionId: 'provider-history' } },
  });
  const domain = new SessionDomainService();
  const persistence = { persistClosedSession: vi.fn(async () => undefined) };
  const repository = {
    getSessionById: vi.fn(async () => session),
    deleteSession: vi.fn(async () => session),
    recoverStaleRunningSessions: vi.fn(async () => 0),
  };
  const finalizer = new SessionWorkflowFinalizer({
    repository,
    workspaceLookup: { findById: async () => ({ worktreePath: '/tmp/workspace' }) },
    sessionDomainService: domain,
    closedSessionPersistenceService: persistence,
    hydrateProviderHistory: createProviderHistoryHydrator(domain),
    lifecycleEventService: { hydrate: async () => undefined },
    runtimeManager: {
      isSessionRunning: () => false,
      hasObservedEmptyProviderSession: (id, observedProvider, providerId) =>
        observedEmpty &&
        id === session.id &&
        observedProvider === provider &&
        providerId === 'provider-history',
    },
    countViewers: () => 0,
  });
  return { session, domain, persistence, repository, finalizer };
}

const loadedEmpty = { status: 'loaded', filePath: '/tmp/history.jsonl', history: [] };
const existingMessage: ChatMessage = {
  id: 'user-1',
  source: 'user',
  text: 'Saved conversation',
  timestamp: '2026-10-30T00:00:00Z',
  order: 0,
};

describe('closed-session provider history safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'refuses to archive unavailable %s history even when local status cards exist',
    async (provider) => {
      const { finalizer, domain, persistence } = setup(provider);
      loadHistory.mockResolvedValue({ status: 'not_found' });
      domain.replaceTranscript('session-1', [
        {
          id: 'local-status',
          source: 'agent',
          timestamp: '2026-10-30T00:00:00Z',
          order: 0,
          message: { type: 'pr_update', prDeliveryState: 'failed' },
        },
      ]);
      await expect(finalizer.persistClosedSession('session-1')).rejects.toThrow('history');
      expect(persistence.persistClosedSession).not.toHaveBeenCalled();
      expect(domain.getTranscriptSnapshot('session-1')).toHaveLength(1);
    }
  );

  it('archives an observed new session that never received a prompt even without a provider file', async () => {
    const { finalizer, persistence } = setup('CLAUDE', false, true);
    loadHistory.mockResolvedValue({ status: 'not_found' });
    await finalizer.persistClosedSession('session-1');
    expect(persistence.persistClosedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'provider-history',
        messages: [],
      })
    );
  });

  it('protects provider identities retained only in metadata', async () => {
    const { finalizer, persistence } = setup('CLAUDE', true);
    loadHistory.mockResolvedValue({ status: 'not_found' });
    await expect(finalizer.persistClosedSession('session-1')).rejects.toThrow('history');
    expect(persistence.persistClosedSession).not.toHaveBeenCalled();
  });

  it('retains an unavailable transient session and retries history after the cooldown', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const h = setup();
    loadHistory.mockResolvedValueOnce({
      status: 'error',
      reason: 'read_failed',
      filePath: '/tmp/history.jsonl',
    });
    const close = () =>
      h.finalizer.finalizeDeliberateStop({
        session: h.session,
        sessionId: 'session-1',
        cleanupTransientRatchetSession: true,
      });
    await close();
    expect(h.repository.deleteSession).not.toHaveBeenCalled();
    expect(h.persistence.persistClosedSession).not.toHaveBeenCalled();
    await close(); // The hydration cooldown must also fail closed.
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(h.repository.deleteSession).not.toHaveBeenCalled();
    clock.mockReturnValue(1_800_000_030_001);
    loadHistory.mockResolvedValueOnce({
      ...loadedEmpty,
      history: [
        {
          type: 'user',
          uuid: 'turn-1',
          timestamp: '2026-10-30T00:00:00Z',
          content: 'Recovered history',
        },
      ],
    });
    await close();
    expect(h.repository.deleteSession).toHaveBeenCalledOnce();
    expect(h.persistence.persistClosedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ text: 'Recovered history' })],
      })
    );
  });

  it('retries an empty ACP fallback instead of treating it as confirmed empty history', async () => {
    const { finalizer, domain, persistence } = setup();
    domain.replaceTranscript('session-1', [], { historySource: 'acp_fallback' });
    loadHistory.mockResolvedValue(loadedEmpty);
    await finalizer.persistClosedSession('session-1');
    expect(loadHistory).toHaveBeenCalledOnce();
    expect(domain.getHistoryHydrationSource('session-1')).toBe('jsonl');
    expect(persistence.persistClosedSession).toHaveBeenCalledOnce();
  });

  it('allows a confirmed loaded-empty transcript to be archived', async () => {
    const { finalizer, persistence } = setup();
    loadHistory.mockResolvedValue(loadedEmpty);
    await finalizer.persistClosedSession('session-1');
    expect(persistence.persistClosedSession).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [] })
    );
  });

  it('allows retained provider messages when the provider file is unavailable', async () => {
    const { finalizer, domain, persistence } = setup('CODEX');
    loadHistory.mockResolvedValue({ status: 'not_found' });
    domain.replaceTranscript('session-1', [existingMessage]);
    await finalizer.persistClosedSession('session-1');
    expect(persistence.persistClosedSession).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [existingMessage] })
    );
  });

  it('allows a session with no provider conversation to archive its local history', async () => {
    const h = setup();
    h.session.providerSessionId = null;
    h.session.providerMetadata = null;
    await h.finalizer.persistClosedSession('session-1');
    expect(loadHistory).not.toHaveBeenCalled();
    expect(h.persistence.persistClosedSession).toHaveBeenCalledOnce();
  });
});
