import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), history: vi.fn() }));
vi.mock('../data/session-data.service', () => ({
  sessionDataService: { findAgentSessionById: mocks.session },
}));
vi.mock('../data/session-history-loader.service', () => ({
  claudeSessionHistoryLoaderService: { loadSessionHistory: mocks.history },
}));
vi.mock('../data/codex-session-history-loader.service', () => ({
  codexSessionHistoryLoaderService: { loadSessionHistory: mocks.history },
}));

import { findPRDeliveryReceipt } from './session-pr-receipt';

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
