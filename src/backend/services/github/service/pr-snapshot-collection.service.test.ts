import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { workspacePrSnapshotService } from '@/backend/services/workspace';
import type { GitHubWorkspaceBridge } from './bridges';

const observe = vi.fn();

import {
  PR_DETACHED,
  PR_SNAPSHOT_UPDATED,
  PR_URL_ATTACHED,
  prSnapshotService,
} from './pr-snapshot.service';

type PR = NonNullable<Awaited<ReturnType<typeof workspacePrSnapshotService.find>>>;
const makePR = (
  id: string,
  url = `https://github.com/org/repo/pull/${id === 'a' ? 42 : 43}`
): PR => ({
  id,
  url,
  workspaceId: 'w',
  number: 42,
  title: null,
  headRefName: null,
  baseRefName: null,
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
  detachedAt: null,
  revision: 3,
  ciFailedAt: null,
  ciLastNotifiedAt: null,
  reviewLastCheckedAt: null,
  reviewLastCommentId: null,
  observation: null,
  observationEpoch: 0,
  transitionSequence: 0,
});
const claim = {
  githubOwner: 'org',
  githubRepo: 'repo',
  branchName: 'feature',
  checkedAt: new Date(),
  retryCount: 1,
  nextCheckAt: new Date(),
};
const bridge = {
  findPRContext: vi.fn(),
  listPRs: vi.fn(),
  findPR: vi.fn(),
  attachPR: vi.fn(),
  detachPR: vi.fn(),
  attachDiscoveredPRsIfClaimMatches: vi.fn(),
} satisfies GitHubWorkspaceBridge;
beforeEach(() => {
  vi.resetAllMocks();
  bridge.findPRContext.mockResolvedValue({ branchName: 'feature', prUrl: null });
  bridge.listPRs.mockResolvedValue([makePR('a'), makePR('b')]);
  bridge.findPR.mockImplementation(({ workspaceId, prId }) =>
    Promise.resolve(workspaceId === 'w' ? makePR(prId) : null)
  );
  bridge.attachPR.mockResolvedValue({ prId: 'a', created: true, reattached: false });
  bridge.attachDiscoveredPRsIfClaimMatches.mockResolvedValue(['a', 'b']);
  observe.mockResolvedValue(true);
  prSnapshotService.configure({ workspace: bridge, observe });
});
afterEach(() => prSnapshotService.removeAllListeners());
describe('PRSnapshotService collection targets', () => {
  it('reports a retained attachment when its initial observation throws', async () => {
    observe.mockRejectedValue(new Error('offline'));
    expect(await prSnapshotService.attachAndRefreshPR('w', makePR('a').url)).toEqual({
      success: false,
      reason: 'error',
      prId: 'a',
    });
  });

  it('rejects attachment to a missing workspace', async () => {
    bridge.findPRContext.mockResolvedValue(null);
    expect(await prSnapshotService.attachAndRefreshPR('missing', makePR('a').url)).toEqual({
      success: false,
      reason: 'workspace_not_found',
    });
    expect(bridge.attachPR).not.toHaveBeenCalled();
  });
  it('publishes the retained attachment before a rejected observation', async () => {
    observe.mockResolvedValue(false);
    const attached = vi.fn();
    prSnapshotService.on(PR_URL_ATTACHED, attached);
    expect(await prSnapshotService.attachAndRefreshPR('w', makePR('a').url)).toEqual({
      success: false,
      reason: 'stale_observation',
      prId: 'a',
    });
    expect(attached).toHaveBeenCalledWith({ workspaceId: 'w', prId: 'a', prUrl: makePR('a').url });
  });
  it.each([
    { created: false, reattached: false },
    { created: false, reattached: true },
  ])('reattachment events follow lifecycle $reattached', async (flags) => {
    bridge.attachPR.mockResolvedValue({ prId: 'a', ...flags });
    const attached = vi.fn();
    prSnapshotService.on(PR_URL_ATTACHED, attached);
    await prSnapshotService.attachAndRefreshPR('w', makePR('a').url);
    expect(attached).toHaveBeenCalledTimes(flags.reattached ? 1 : 0);
  });
  it('observes the explicit association and reads its committed fields', async () => {
    expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'b' })).toEqual({
      success: true,
      snapshot: {
        prNumber: 42,
        prState: 'OPEN',
        prReviewState: null,
        prCiStatus: 'SUCCESS',
      },
    });
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'w', prId: 'b' },
      { force: true }
    );
  });
  it('publishes nothing when a delayed refresh loses its revision guard', async () => {
    observe.mockResolvedValue(false);
    const listener = vi.fn();
    prSnapshotService.on(PR_SNAPSHOT_UPDATED, listener);
    expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'a' })).toEqual({
      success: false,
      reason: 'stale_observation',
    });
    expect(listener).not.toHaveBeenCalled();
  });
  it('rejects cross-workspace and detached targets before observing', async () => {
    expect(await prSnapshotService.refreshPR({ workspaceId: 'other', prId: 'a' })).toEqual({
      success: false,
      reason: 'no_pr_url',
    });
    expect(observe).not.toHaveBeenCalled();
    bridge.findPR.mockResolvedValue(null);
    expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'detached' })).toEqual({
      success: false,
      reason: 'no_pr_url',
    });
    expect(observe).not.toHaveBeenCalled();
  });
  it('refreshes every attached PR, including terminal siblings', async () => {
    bridge.listPRs.mockResolvedValue([makePR('a'), { ...makePR('b'), state: 'CLOSED' }]);
    expect((await prSnapshotService.refreshWorkspace('w')).success).toBe(true);
    expect(observe.mock.calls).toEqual([
      [{ workspaceId: 'w', prId: 'a' }, { force: true }],
      [{ workspaceId: 'w', prId: 'b' }, { force: true }],
    ]);
  });
  it.each(['findPRContext', 'listPRs'] as const)(
    'maps %s read failures to an error result',
    async (method) => {
      bridge[method].mockRejectedValue(new Error('database unavailable'));
      await expect(prSnapshotService.refreshWorkspace('w')).resolves.toEqual({
        success: false,
        reason: 'error',
      });
      expect(observe).not.toHaveBeenCalled();
    }
  );
  it('continues refreshing siblings after an observation failure', async () => {
    observe.mockResolvedValueOnce(false);
    expect(await prSnapshotService.refreshWorkspace('w')).toEqual({
      success: false,
      reason: 'stale_observation',
    });
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it('reports an empty collection and a missing workspace separately', async () => {
    bridge.listPRs.mockResolvedValue([]);
    expect(await prSnapshotService.refreshWorkspace('w')).toEqual({
      success: false,
      reason: 'no_pr_url',
    });
    bridge.findPRContext.mockResolvedValue(null);
    expect(await prSnapshotService.refreshWorkspace('w')).toEqual({
      success: false,
      reason: 'workspace_not_found',
    });
  });
  it('attaches grouped discoveries under one claim and refreshes all new IDs', async () => {
    expect(
      await prSnapshotService.attachDiscoveredPRsAndRefresh(
        'w',
        [makePR('a').url, makePR('b').url],
        claim
      )
    ).toBe(2);
    expect(bridge.attachDiscoveredPRsIfClaimMatches).toHaveBeenCalledExactlyOnceWith('w', claim, [
      makePR('a').url,
      makePR('b').url,
    ]);
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it('does not observe when discovery loses its claim', async () => {
    bridge.attachDiscoveredPRsIfClaimMatches.mockResolvedValue([]);
    expect(
      await prSnapshotService.attachDiscoveredPRAndRefresh('w', makePR('a').url, claim)
    ).toEqual({ success: false, reason: 'claim_stale' });
    expect(observe).not.toHaveBeenCalled();
  });
  it('counts retained discoveries even when snapshots fail', async () => {
    observe.mockResolvedValue(false);
    expect(
      await prSnapshotService.attachDiscoveredPRsAndRefresh(
        'w',
        [makePR('a').url, makePR('b').url],
        claim
      )
    ).toBe(2);
  });
  it('publishes detachment only when the exact association was removed', async () => {
    bridge.detachPR
      .mockResolvedValueOnce({ removed: true, dispatchReleased: false })
      .mockResolvedValueOnce({ removed: false, dispatchReleased: false });
    const listener = vi.fn();
    prSnapshotService.on(PR_DETACHED, listener);
    const target = { workspaceId: 'w', prId: 'b' };
    await prSnapshotService.detachPR(target);
    await prSnapshotService.detachPR(target);
    expect(listener).toHaveBeenCalledExactlyOnceWith(target);
  });
  it('handles observation exceptions without publishing snapshots', async () => {
    observe.mockRejectedValue(new Error('offline'));
    const listener = vi.fn();
    prSnapshotService.on(PR_SNAPSHOT_UPDATED, listener);
    expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'a' })).toEqual({
      success: false,
      reason: 'error',
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
