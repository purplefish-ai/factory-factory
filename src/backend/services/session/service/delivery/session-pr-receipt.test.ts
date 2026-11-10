import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  history: vi.fn(),
  archives: vi.fn(),
  identity: vi.fn(),
}));
vi.mock('@/backend/services/session/resources/closed-session.accessor', () => ({
  closedSessionAccessor: { findBySessionIdWithWorkspace: mocks.archives },
}));
vi.mock('@/backend/services/session/service/data/session-data.service', () => ({
  sessionDataService: {
    findAgentSessionById: mocks.session,
    readClosedSessionProviderIdentity: mocks.identity,
  },
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
      workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
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
        id: 'closed-1',
        sessionId: 'main',
        workspaceId: 'workspace-1',
        provider,
        transcriptPath: '.context/closed-sessions/main.json',
        workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
      },
    ]);
    mocks.identity.mockResolvedValue({
      provider,
      providerSessionId: 'closed-provider',
      workingDir: '/tmp/repo',
    });
    mocks.history.mockResolvedValue({
      status: 'loaded',
      history: [{ type: 'user', content: '<!-- factory-factory-pr-event:delivery -->' }],
    });
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('delivered');
    expect(mocks.identity).toHaveBeenCalledExactlyOnceWith('closed-1');
    expect(mocks.history).toHaveBeenLastCalledWith({
      providerSessionId: 'closed-provider',
      workingDir: '/tmp/repo',
      onlyLinesContaining: '<!-- factory-factory-pr-event:delivery -->',
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
      codexAccountId: null,
      workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
    });
    mocks.archives.mockResolvedValue([
      {
        id: 'closed-1',
        sessionId: 'main',
        workspaceId: 'workspace-1',
        provider: 'CODEX',
        transcriptPath: 'old.json',
        workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
      },
    ]);
    mocks.identity.mockResolvedValue({
      provider: 'CODEX',
      providerSessionId: 'original',
      codexAccountId: null,
      workingDir: '/tmp/repo',
    });
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
    workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
  });
  mocks.archives.mockResolvedValue([
    {
      id: 'closed-1',
      sessionId: 'main',
      workspaceId: 'workspace-1',
      provider: 'CODEX',
      transcriptPath: 'old.json',
      workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
    },
  ]);
  mocks.identity.mockRejectedValue(new Error('missing old transcript'));
  mocks.history.mockResolvedValue({ status: 'loaded', history: [] });
  expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('unavailable');
});

it('checks retained rollover identities when no local transcript was archived', async () => {
  mocks.session.mockResolvedValue({
    provider: 'CODEX',
    providerSessionId: 'replacement',
    providerMetadata: { providerIdentityRollovers: [{ previousProviderSessionId: 'original' }] },
    workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
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

it.each([
  ['account-1', undefined],
  [null, undefined],
  ['account-1', 'account-2'],
  ['account-1', null],
  [null, 'account-1'],
])(
  'does not match known live account %s to archived account %s',
  async (codexAccountId, archivedAccountId) => {
    mocks.session.mockResolvedValue({
      provider: 'CODEX',
      providerSessionId: 'replacement',
      codexAccountId,
      workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
    });
    mocks.archives.mockResolvedValue([
      {
        id: 'closed-1',
        sessionId: 'main',
        workspaceId: 'workspace-1',
        provider: 'CODEX',
        transcriptPath: 'old.json',
        workspace: { id: 'workspace-1', worktreePath: '/tmp/repo' },
      },
    ]);
    mocks.identity.mockResolvedValue({
      provider: 'CODEX',
      providerSessionId: 'original',
      codexAccountId: archivedAccountId,
      workingDir: '/tmp/repo',
    });
    mocks.history.mockImplementation(async ({ providerSessionId }) => ({
      status: 'loaded',
      history:
        providerSessionId === 'original'
          ? [{ type: 'user', content: '<!-- factory-factory-pr-event:delivery -->' }]
          : [],
    }));
    expect(await findPRDeliveryReceipt('main', 'delivery')).toBe('unavailable');
  }
);
