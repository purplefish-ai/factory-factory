import { beforeEach, expect, it, vi } from 'vitest';
import type { GitHubWorkspaceBridge } from './bridges';
import { PR_URL_ATTACHED, prSnapshotService } from './pr-snapshot.service';

const url = 'https://github.com/org/repo/pull/1';
const row = {
  id: 'p',
  workspaceId: 'w',
  url,
  revision: 0,
  number: 1,
  state: 'OPEN' as const,
  reviewState: null,
  ciStatus: 'PENDING' as const,
};
const bridge = {
  listPRs: vi.fn(),
  findPR: vi.fn(),
  attachPR: vi.fn(),
  detachPR: vi.fn(),
  attachDiscoveredPRsIfClaimMatches: vi.fn(),
  findPRContext: vi.fn(),
  recordSnapshot: vi.fn(),
  applyPrSnapshotWithDispatchReset: vi.fn(),
  applyPrObservationWithDispatchReset: vi.fn(),
  attachDiscoveredPRIfClaimMatches: vi.fn(),
  updatePRSnapshotIfUrlMatches: vi.fn(),
} satisfies GitHubWorkspaceBridge;
const observe = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  prSnapshotService.removeAllListeners();
  prSnapshotService.configure({ workspace: bridge, observe });
  bridge.findPRContext.mockResolvedValue({ branchName: 'branch', prUrl: url });
  bridge.findPR.mockResolvedValue(row);
  bridge.listPRs.mockResolvedValue([row]);
  bridge.attachPR.mockResolvedValue({ prId: 'p', created: true, reattached: false });
  observe.mockResolvedValue(true);
});
it('rejects attachment for a missing workspace', async () => {
  bridge.findPRContext.mockResolvedValue(null);
  expect(await prSnapshotService.attachAndRefreshPR('w', url)).toEqual({
    success: false,
    reason: 'workspace_not_found',
  });
  expect(bridge.attachPR).not.toHaveBeenCalled();
});
it('keeps an attachment visible when the subsequent observation fails', async () => {
  observe.mockResolvedValue(false);
  const listener = vi.fn();
  prSnapshotService.on(PR_URL_ATTACHED, listener);
  expect(await prSnapshotService.attachAndRefreshPR('w', url)).toMatchObject({
    success: false,
    prId: 'p',
  });
  expect(listener).toHaveBeenCalledWith({ workspaceId: 'w', prId: 'p', prUrl: url });
});
it('routes manual refresh through the same full observation pipeline', async () => {
  expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'p' })).toMatchObject({
    success: true,
  });
  expect(observe).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'w', prId: 'p' }, { force: true });
  expect(bridge.applyPrSnapshotWithDispatchReset).not.toHaveBeenCalled();
});
it('refreshes every explicit association and reports a sibling failure', async () => {
  bridge.listPRs.mockResolvedValue([row, { ...row, id: 'p2' }]);
  observe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await prSnapshotService.refreshWorkspace('w')).toMatchObject({ success: false });
  expect(observe).toHaveBeenCalledTimes(2);
});
it('does not attach discovery results when their claim is stale', async () => {
  bridge.attachDiscoveredPRsIfClaimMatches.mockResolvedValue([]);
  expect(
    await prSnapshotService.attachDiscoveredPRAndRefresh('w', url, {
      branchName: 'branch',
      githubOwner: 'org',
      githubRepo: 'repo',
      checkedAt: new Date(),
      retryCount: 1,
      nextCheckAt: new Date(),
    })
  ).toEqual({ success: false, reason: 'claim_stale' });
  expect(observe).not.toHaveBeenCalled();
});
it('detaches only the explicit target', async () => {
  bridge.detachPR.mockResolvedValue({ removed: true, dispatchReleased: false });
  expect(await prSnapshotService.detachPR({ workspaceId: 'w', prId: 'p' })).toEqual({
    removed: true,
    dispatchReleased: false,
  });
  expect(bridge.detachPR).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'w', prId: 'p' });
});
it('returns an error result when listing associations fails', async () => {
  bridge.listPRs.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(prSnapshotService.refreshWorkspace('w')).resolves.toEqual({
    success: false,
    reason: 'error',
  });
});
it('returns an error result when a discovery attachment fails', async () => {
  bridge.attachDiscoveredPRsIfClaimMatches.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(
    prSnapshotService.attachDiscoveredPRAndRefresh('w', url, {
      branchName: 'branch',
      githubOwner: 'org',
      githubRepo: 'repo',
      checkedAt: new Date(),
      retryCount: 1,
      nextCheckAt: new Date(),
    })
  ).resolves.toEqual({ success: false, reason: 'error' });
});
