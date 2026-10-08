import { expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
vi.mock('@/backend/db', () => ({ prisma: { workspace: { findUnique: read } } }));

import {
  derivePRCollectionState,
  flattenWorkspaceRatchet,
  workspaceRatchetAccessor,
} from './workspace-ratchet.accessor';

it('keeps a workspace active while a sibling PR is open', () => {
  expect(
    derivePRCollectionState([
      { state: 'MERGED', ciStatus: 'SUCCESS', hasMergeConflict: false, reviewState: null },
      { state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: false, reviewState: null },
    ])
  ).toBe('CI_FAILED');
});
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
