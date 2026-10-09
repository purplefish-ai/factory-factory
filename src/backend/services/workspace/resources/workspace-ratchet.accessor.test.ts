import { expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
vi.mock('@/backend/db', () => ({ prisma: { workspace: { findUnique: read } } }));

import { flattenWorkspaceRatchet, workspaceRatchetAccessor } from './workspace-ratchet.accessor';

it('projects a missing configuration as disabled with no recipient', () => {
  expect(flattenWorkspaceRatchet(null)).toMatchObject({
    ratchetEnabled: false,
    prMonitoring: { recipientSessionId: null, bindingRevision: 0 },
  });
});
it('projects a paused recipient and persisted pending count', async () => {
  read.mockResolvedValue({
    status: 'READY',
    prs: [],
    prMonitoring: {
      enabled: true,
      recipientSessionId: 'main',
      bindingRevision: 4,
      deliveryPauseReason: 'USER_STOPPED',
      lastCheckedAt: null,
    },
    _count: { prEvents: 2 },
  });
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prMonitoring: { recipientSessionId: 'main', pauseReason: 'USER_STOPPED', pendingEventCount: 2 },
  });
});

it('publishes collection facts while selecting the active sibling link', async () => {
  read.mockResolvedValue({
    status: 'READY',
    prs: [
      {
        id: 'merged',
        url: 'https://github.com/o/r/pull/1',
        number: 1,
        state: 'MERGED',
        ciStatus: 'SUCCESS',
        hasMergeConflict: true,
        syncedAt: null,
      },
      {
        id: 'open',
        url: 'https://github.com/o/r/pull/2',
        number: 2,
        state: 'OPEN',
        ciStatus: 'FAILURE',
        hasMergeConflict: false,
        syncedAt: null,
      },
    ],
    prMonitoring: { enabled: true },
    _count: { prEvents: 2 },
  });
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prUrl: 'https://github.com/o/r/pull/2',
    prNumber: 2,
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
    prHasMergeConflict: false,
    ratchetState: 'CI_FAILED',
    prSummary: { state: 'OPEN', totalCount: 2 },
    prs: [expect.objectContaining({ id: 'merged' }), expect.objectContaining({ id: 'open' })],
  });
});
it('keeps mixed merged and closed associations closed in the snapshot projection', async () => {
  read.mockResolvedValue({
    status: 'READY',
    prs: [
      {
        id: 'merged',
        url: 'https://github.com/o/r/pull/1',
        state: 'MERGED',
        ciStatus: 'SUCCESS',
        syncedAt: null,
      },
      {
        id: 'closed',
        url: 'https://github.com/o/r/pull/2',
        state: 'CLOSED',
        ciStatus: 'SUCCESS',
        syncedAt: null,
      },
    ],
    prMonitoring: { enabled: true },
    _count: { prEvents: 0 },
  });
  expect(await workspaceRatchetAccessor.findSnapshotProjection('w')).toMatchObject({
    prState: 'CLOSED',
    prSummary: { state: 'CLOSED' },
    ratchetState: 'IDLE',
  });
});
