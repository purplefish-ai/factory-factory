import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  history: vi.fn(),
  archives: vi.fn(),
  read: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readFile: mocks.read }));
vi.mock('@/backend/services/session/resources/closed-session.accessor', () => ({
  closedSessionAccessor: { findBySessionIdWithWorkspace: mocks.archives },
}));
vi.mock('@/backend/services/session/service/data/session-data.service', () => ({
  sessionDataService: { findAgentSessionById: mocks.session },
}));
vi.mock('@/backend/services/session/service/data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: { loadSessionHistory: mocks.history },
}));
vi.mock('@/backend/services/session/service/data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: { loadSessionHistory: mocks.history },
}));

import { findPRDeliveryReceipt } from './session-pr-receipt';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.archives.mockResolvedValue([]);
});

it.each(['CLAUDE', 'CODEX'])(
  'does not acknowledge an optimistic local message for %s',
  async (provider) => {
    mocks.session.mockResolvedValue({
      provider,
      providerSessionId: 'existing',
      workspace: { worktreePath: '/tmp/repo' },
    });
    mocks.history.mockResolvedValue({ status: 'not_found' });
    expect(await findPRDeliveryReceipt('main', 'delivery')).not.toBe('delivered');
    mocks.history.mockResolvedValue({
      status: 'loaded',
      history: [{ type: 'assistant', content: '<!-- factory-factory-pr-event:delivery -->' }],
    });
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('absent');
    mocks.history.mockResolvedValue({
      status: 'loaded',
      history: [{ type: 'user', content: '<!-- factory-factory-pr-event:delivery -->\nPR update' }],
    });
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('delivered');
  }
);
it.each(['CLAUDE', 'CODEX'])(
  'recovers receipts after closing a %s recipient using archived provider identity',
  async (provider) => {
    mocks.session.mockResolvedValue(null);
    mocks.archives.mockResolvedValue([
      {
        sessionId: 'main',
        provider,
        transcriptPath: '.context/closed-sessions/main.json',
        workspace: { worktreePath: '/tmp/repo' },
      },
    ]);
    mocks.read.mockResolvedValue(
      JSON.stringify({
        sessionId: 'main',
        metadata: { provider, providerSessionId: 'closed-provider' },
      })
    );
    mocks.history.mockResolvedValue({
      status: 'loaded',
      history: [{ type: 'user', content: '<!-- factory-factory-pr-event:delivery -->' }],
    });
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('delivered');
    expect(mocks.history).toHaveBeenLastCalledWith({
      providerSessionId: 'closed-provider',
      workingDir: '/tmp/repo',
    });
    mocks.history.mockResolvedValue({ status: 'loaded', history: [] });
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('absent');
    mocks.history.mockResolvedValue({ status: 'not_found' });
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('unavailable');
  }
);

it.each(['loaded', 'not_found', 'throws'])(
  'finds a receipt in the old identity after live identity rollover (%s)',
  async (status) => {
    mocks.session.mockResolvedValue({
      provider: 'CODEX',
      providerSessionId: 'replacement',
      workspace: { worktreePath: '/tmp/repo' },
    });
    mocks.archives.mockResolvedValue([
      {
        sessionId: 'main',
        provider: 'CODEX',
        transcriptPath: 'old.json',
        workspace: { worktreePath: '/tmp/repo' },
      },
    ]);
    mocks.read.mockResolvedValue(
      JSON.stringify({
        sessionId: 'main',
        metadata: { provider: 'CODEX', providerSessionId: 'original' },
      })
    );
    mocks.history.mockImplementation(({ providerSessionId }) => {
      if (providerSessionId !== 'original' && status === 'throws') {
        return Promise.reject(new Error('live history unavailable'));
      }
      return Promise.resolve(
        providerSessionId === 'original'
          ? {
              status: 'loaded',
              history: [{ type: 'user', content: '<!-- factory-factory-pr-event:delivery -->' }],
            }
          : { status, history: [] }
      );
    });
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('delivered');
  }
);
it('does not conclude absence when the rolled-over transcript is unavailable', async () => {
  mocks.session.mockResolvedValue({
    provider: 'CODEX',
    providerSessionId: 'replacement',
    workspace: { worktreePath: '/tmp/repo' },
  });
  mocks.archives.mockResolvedValue([
    {
      sessionId: 'main',
      provider: 'CODEX',
      transcriptPath: 'old.json',
      workspace: { worktreePath: '/tmp/repo' },
    },
  ]);
  mocks.read.mockRejectedValue(new Error('missing old transcript'));
  mocks.history.mockResolvedValue({ status: 'loaded', history: [] });
  expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('unavailable');
});

it('checks retained rollover identities when no local transcript was archived', async () => {
  mocks.session.mockResolvedValue({
    provider: 'CODEX',
    providerSessionId: 'replacement',
    providerMetadata: { providerIdentityRollovers: [{ previousProviderSessionId: 'original' }] },
    workspace: { worktreePath: '/tmp/repo' },
  });
  mocks.history.mockImplementation(async ({ providerSessionId }) => ({
    status: 'loaded',
    history:
      providerSessionId === 'original'
        ? [{ type: 'user', content: '<!-- factory-factory-pr-event:delivery -->' }]
        : [],
  }));
  expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('delivered');
});
