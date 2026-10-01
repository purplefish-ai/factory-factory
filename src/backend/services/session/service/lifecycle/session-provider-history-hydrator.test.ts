import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { ChatMessage } from '@/shared/acp-protocol';
import {
  hydrateProviderHistoryIfNeeded,
  type ProviderHistorySession,
} from './session-provider-history-hydrator';

const { loadCodex, loadClaude } = vi.hoisted(() => ({ loadCodex: vi.fn(), loadClaude: vi.fn() }));
vi.mock('@/backend/services/session/service/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: { loadSessionHistory: loadCodex },
}));
vi.mock('@/backend/services/session/service/data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: { loadSessionHistory: loadClaude },
}));

const record = (id: string): ProviderHistorySession => ({
  provider: 'CODEX',
  providerSessionId: id,
  providerMetadata: { acpConfigSnapshot: { provider: 'CODEX', providerSessionId: id } },
  workspace: { worktreePath: '/tmp/history-fixture' },
});
const oldMessage: ChatMessage = {
  id: 'previous',
  source: 'user',
  text: 'previous identity',
  timestamp: '2026-01-01T00:00:00Z',
  order: 0,
};
const loaded = (text: string) => ({
  status: 'loaded',
  filePath: '/tmp/fixture.jsonl',
  history: [
    {
      type: 'user',
      uuid: text,
      timestamp: '2026-01-01T00:00:00Z',
      content: text,
    },
  ],
});

describe('history hydration after provider identity rollover', () => {
  beforeEach(() => {
    sessionDomainService.clearAllSessions();
  });

  it('loads only the reconciled identity in process and after backend restart', async () => {
    sessionDomainService.replaceTranscript('history-session', [oldMessage], {
      historySource: 'jsonl',
    });
    sessionDomainService.resetProviderHistory('history-session', 'new');
    loadCodex.mockResolvedValue(loaded('new turn'));
    await hydrateProviderHistoryIfNeeded('history-session', record('new'));
    expect(loadCodex).toHaveBeenCalledWith({
      providerSessionId: 'new',
      workingDir: '/tmp/history-fixture',
    });
    expect(
      sessionDomainService.getTranscriptSnapshot('history-session').map((entry) => entry.text)
    ).toEqual(['new turn']);
    sessionDomainService.clearAllSessions(); // Simulate a fresh backend process.
    await hydrateProviderHistoryIfNeeded('history-session', record('new'));
    expect(
      sessionDomainService.getTranscriptSnapshot('history-session').map((entry) => entry.text)
    ).toEqual(['new turn']);
    expect(loadCodex.mock.calls.every(([input]) => input.providerSessionId === 'new')).toBe(true);
  });

  it.each(['loaded', 'not_found'] as const)(
    'ignores an old in-flight %s result after rollover',
    async (status) => {
      const oldRead = createDeferred<unknown>();
      loadCodex.mockReturnValue(oldRead.promise);
      const hydration = hydrateProviderHistoryIfNeeded('history-session', record('old'));
      await vi.waitFor(() => expect(loadCodex).toHaveBeenCalledOnce());
      sessionDomainService.resetProviderHistory('history-session', 'new');
      oldRead.resolve(status === 'loaded' ? loaded('wrong stale turn') : { status: 'not_found' });
      await hydration;
      expect(sessionDomainService.getTranscriptSnapshot('history-session')).toEqual([]);
      expect(sessionDomainService.canAttemptHistoryHydration('history-session')).toBe(true);
      loadCodex.mockClear();
      await hydrateProviderHistoryIfNeeded('history-session', record('old'));
      expect(loadCodex).not.toHaveBeenCalled();
    }
  );

  it('does not resurrect a stale history read after the in-memory session is cleared', async () => {
    const oldRead = createDeferred<unknown>();
    loadCodex.mockReturnValue(oldRead.promise);
    const hydration = hydrateProviderHistoryIfNeeded('history-session', record('old'));
    await vi.waitFor(() => expect(loadCodex).toHaveBeenCalledOnce());
    sessionDomainService.resetProviderHistory('history-session', 'new');
    sessionDomainService.clearSession('history-session');
    oldRead.resolve(loaded('wrong old turn'));
    await hydration;
    expect(sessionDomainService.getTranscriptSnapshot('history-session')).toEqual([]);
    expect(sessionDomainService.acceptProviderHistoryIdentity('history-session', 'new')).toBe(true);
  });

  it('invalidates old reads before archival and permits fresh reads if repair fails', async () => {
    const oldRead = createDeferred<unknown>();
    loadCodex.mockReturnValue(oldRead.promise);
    const hydration = hydrateProviderHistoryIfNeeded('history-session', record('old'));
    await vi.waitFor(() => expect(loadCodex).toHaveBeenCalledOnce());
    const resumeHistory = sessionDomainService.suspendProviderHistory('history-session');
    oldRead.resolve(loaded('old read completed during archival'));
    await hydration;
    expect(sessionDomainService.getTranscriptSnapshot('history-session')).toEqual([]);
    await hydrateProviderHistoryIfNeeded('history-session', record('old'));
    expect(loadCodex).toHaveBeenCalledOnce();
    resumeHistory();
    loadCodex.mockResolvedValue(loaded('retained old history'));
    await hydrateProviderHistoryIfNeeded('history-session', record('old'));
    expect(sessionDomainService.getTranscriptSnapshot('history-session')[0]?.text).toBe(
      'retained old history'
    );
  });

  it('rejects an old database record delivered after rollover and inactive store eviction', async () => {
    sessionDomainService.resetProviderHistory('history-session', 'new');
    sessionDomainService.clearSession('history-session', { preserveRejections: true });
    loadCodex.mockResolvedValue(loaded('wrong delayed DB record'));
    await hydrateProviderHistoryIfNeeded('history-session', record('old'));
    expect(loadCodex).not.toHaveBeenCalled();
    expect(sessionDomainService.getTranscriptSnapshot('history-session')).toEqual([]);
    loadCodex.mockResolvedValue(loaded('new identity history'));
    await hydrateProviderHistoryIfNeeded('history-session', record('new'));
    expect(sessionDomainService.getTranscriptSnapshot('history-session')[0]?.text).toBe(
      'new identity history'
    );
  });

  it('retries empty replacement history using the new identity instead of the stale ID', async () => {
    sessionDomainService.resetProviderHistory('history-session', 'new');
    loadCodex.mockResolvedValue({ status: 'not_found' });
    await hydrateProviderHistoryIfNeeded('history-session', record('new'));
    expect(sessionDomainService.canAttemptHistoryHydration('history-session')).toBe(false);
    sessionDomainService.clearHistoryRetryCooldown('history-session');
    loadCodex.mockResolvedValue(loaded('eventually persisted'));
    await hydrateProviderHistoryIfNeeded('history-session', record('new'));
    expect(sessionDomainService.getTranscriptSnapshot('history-session')[0]?.text).toBe(
      'eventually persisted'
    );
    expect(loadCodex.mock.calls.every(([input]) => input.providerSessionId === 'new')).toBe(true);
  });

  it('backfills new Codex tools into a live transcript and rejects stale tools across rollover', async () => {
    const toolHistory = (id: string) => ({
      status: 'loaded',
      filePath: '/tmp/fixture.jsonl',
      history: [
        { type: 'assistant', content: 'before tool', timestamp: '2026-01-01T00:00:00Z' },
        {
          type: 'tool_use',
          content: '',
          timestamp: '2026-01-01T00:00:01Z',
          toolName: 'exec_command',
          toolId: id,
          toolInput: { cmd: 'pwd' },
        },
        {
          type: 'tool_result',
          content: '/tmp/fixture',
          timestamp: '2026-01-01T00:00:01Z',
          toolId: id,
        },
        { type: 'assistant', content: 'after tool', timestamp: '2026-01-01T00:00:02Z' },
      ],
    });
    const live: ChatMessage[] = ['before tool', 'after tool'].map((text, order) => ({
      id: `live-${order}`,
      source: 'agent',
      timestamp: `2026-01-01T00:00:0${order * 2}Z`,
      order,
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    }));
    const stale = createDeferred<unknown>();
    loadCodex.mockReturnValueOnce(stale.promise);
    const hydration = hydrateProviderHistoryIfNeeded('history-session', record('old'));
    await vi.waitFor(() => expect(loadCodex).toHaveBeenCalledOnce());
    sessionDomainService.resetProviderHistory('history-session', 'new');
    sessionDomainService.replaceTranscript('history-session', live, {
      historySource: 'acp_fallback',
    });
    stale.resolve(toolHistory('stale-tool'));
    await hydration;
    expect(sessionDomainService.getTranscriptSnapshot('history-session')).toEqual(live);
    loadCodex.mockResolvedValueOnce(toolHistory('new-tool'));
    await hydrateProviderHistoryIfNeeded('history-session', record('new'));
    const transcript = JSON.stringify(
      sessionDomainService.getTranscriptSnapshot('history-session')
    );
    expect(transcript).toContain('new-tool');
    expect(transcript).not.toContain('stale-tool');
  });
});
