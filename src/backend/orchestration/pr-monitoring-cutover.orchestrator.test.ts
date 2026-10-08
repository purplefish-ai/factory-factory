import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configs: vi.fn(),
  sessions: vi.fn(),
  stop: vi.fn(),
  find: vi.fn(),
  closed: vi.fn(),
  pause: vi.fn(),
  retired: vi.fn(),
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: {
    listConfigs: mocks.configs,
    pauseWorkspace: mocks.pause,
    completeLegacyRetirement: mocks.retired,
  },
}));
vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    findAgentSessionsByWorkspaceId: mocks.sessions,
    findAgentSessionById: mocks.find,
    findClosedSessionsByWorkspaceId: mocks.closed,
  },
  sessionLifecycleService: { stopSession: mocks.stop },
}));

import { retireLegacyRatchetSessions } from './pr-monitoring-cutover.orchestrator';
beforeEach(() => mocks.pause.mockResolvedValue({ count: 1 }));

it('retires only legacy fixers after confirming their closed transcripts', async () => {
  mocks.configs.mockResolvedValue([{ workspaceId: 'w', bindingRevision: 3 }]);
  mocks.sessions.mockResolvedValue([
    { id: 'main', workflow: 'implement' },
    { id: 'fixer', workflow: 'ratchet' },
  ]);
  mocks.find.mockResolvedValue(null);
  mocks.closed.mockResolvedValue([{ sessionId: 'fixer' }]);
  const result = await retireLegacyRatchetSessions();
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith('fixer', expect.anything());
  expect(result).toEqual({ retired: 1, blockedWorkspaceIds: [] });
  expect(mocks.retired).toHaveBeenCalledExactlyOnceWith('w', 4);
});
it('persists a fence when exact legacy transcripts are missing without live fixers', async () => {
  mocks.configs.mockResolvedValue([
    { workspaceId: 'w', bindingRevision: 3, legacySessionIds: ['gone'] },
  ]);
  mocks.sessions.mockResolvedValue([]);
  mocks.closed.mockResolvedValue([]);
  expect((await retireLegacyRatchetSessions()).blockedWorkspaceIds).toEqual(['w']);
  expect(mocks.pause).toHaveBeenCalledWith('w', 'LEGACY_FIXER', 3);
});
it('does not retire on a lost fence CAS', async () => {
  mocks.configs.mockResolvedValue([{ workspaceId: 'w', bindingRevision: 3 }]);
  mocks.sessions.mockResolvedValue([{ id: 'fixer', workflow: 'ratchet' }]);
  mocks.pause.mockResolvedValue({ count: 0 });
  expect((await retireLegacyRatchetSessions()).blockedWorkspaceIds).toEqual(['w']);
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.retired).not.toHaveBeenCalled();
});
it('isolates corrupt retention metadata to the affected workspace', async () => {
  mocks.configs.mockResolvedValue([
    { workspaceId: 'bad', bindingRevision: 3, legacySessionIds: { bad: true } },
    { workspaceId: 'good', bindingRevision: 0, legacySessionIds: [] },
  ]);
  mocks.sessions.mockResolvedValue([]);
  expect(await retireLegacyRatchetSessions()).toEqual({ retired: 0, blockedWorkspaceIds: ['bad'] });
  expect(mocks.pause).toHaveBeenCalledWith('bad', 'LEGACY_FIXER', 3);
  expect(mocks.retired).toHaveBeenCalledWith('good', 0);
});
it('keeps delivery blocked when a legacy transcript was not retained', async () => {
  mocks.configs.mockResolvedValue([{ workspaceId: 'w', bindingRevision: 3 }]);
  mocks.sessions.mockResolvedValue([{ id: 'fixer', workflow: 'ratchet' }]);
  mocks.find.mockResolvedValue(null);
  mocks.closed.mockResolvedValue([]);
  const result = await retireLegacyRatchetSessions();
  expect(result.blockedWorkspaceIds).toEqual(['w']);
  expect(mocks.retired).not.toHaveBeenCalled();
});
it('keeps a vanished legacy fixer fenced until its exact transcript is confirmed', async () => {
  mocks.configs.mockResolvedValue([
    {
      workspaceId: 'w',
      bindingRevision: 3,
      deliveryPauseReason: 'LEGACY_FIXER',
      legacySessionIds: ['lost-fixer'],
    },
  ]);
  mocks.sessions.mockResolvedValue([{ id: 'main', workflow: 'implement' }]);
  mocks.closed.mockResolvedValue([{ sessionId: 'different-old-fixer' }]);
  expect((await retireLegacyRatchetSessions()).blockedWorkspaceIds).toEqual(['w']);
  expect(mocks.retired).not.toHaveBeenCalled();
});
