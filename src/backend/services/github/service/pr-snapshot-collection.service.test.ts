import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { workspacePrSnapshotService } from '@/backend/services/workspace';
import type { GitHubWorkspaceBridge } from './bridges';

const fetchSnapshot = vi.hoisted(() => vi.fn());
vi.mock('./github-cli.service', () => ({
  githubCLIService: {
    fetchAndComputePRState: fetchSnapshot,
    extractPRInfo: () => ({ number: 42 }),
  },
}));

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
const snapshot = {
  prNumber: 42,
  prState: 'OPEN' as const,
  prReviewState: 'APPROVED',
  prCiStatus: 'SUCCESS' as const,
};
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
  applyPrSnapshotWithDispatchReset: vi.fn(),
  applyPrObservationWithDispatchReset: vi.fn(),
  recordSnapshot: vi.fn(),
  attachDiscoveredPRIfClaimMatches: vi.fn(),
  updatePRSnapshotIfUrlMatches: vi.fn(),
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
  bridge.applyPrSnapshotWithDispatchReset.mockResolvedValue({
    applied: true,
    dispatchReset: false,
  });
  bridge.applyPrObservationWithDispatchReset.mockResolvedValue({
    applied: true,
    dispatchReset: false,
  });
  fetchSnapshot.mockResolvedValue(snapshot);
  prSnapshotService.configure({ workspace: bridge });
});
afterEach(() => prSnapshotService.removeAllListeners());
describe('PRSnapshotService collection targets', () => {
  it('reports a retained attachment when its initial fetch throws', async () => {
    fetchSnapshot.mockRejectedValue(new Error('offline'));
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
  it('publishes the retained attachment before a failed fetch', async () => {
    fetchSnapshot.mockResolvedValue(null);
    const attached = vi.fn();
    prSnapshotService.on(PR_URL_ATTACHED, attached);
    expect(await prSnapshotService.attachAndRefreshPR('w', makePR('a').url)).toEqual({
      success: false,
      reason: 'fetch_failed',
      prId: 'a',
    });
    expect(attached).toHaveBeenCalledWith({ workspaceId: 'w', prId: 'a', prUrl: makePR('a').url });
    expect(bridge.applyPrSnapshotWithDispatchReset).not.toHaveBeenCalled();
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
  it('pins identity and revision before fetching, without overwriting the workspace branch', async () => {
    await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'b' });
    expect(fetchSnapshot).toHaveBeenCalledWith(makePR('b').url);
    expect(bridge.applyPrSnapshotWithDispatchReset).toHaveBeenCalledWith('w', {
      ...snapshot,
      prId: 'b',
      expectedRevision: 3,
      prUpdatedAt: expect.any(Date),
    });
  });
  it('publishes nothing when a delayed refresh loses its revision guard', async () => {
    bridge.applyPrSnapshotWithDispatchReset.mockResolvedValue({
      applied: false,
      dispatchReset: false,
    });
    const listener = vi.fn();
    prSnapshotService.on(PR_SNAPSHOT_UPDATED, listener);
    expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'a' })).toEqual({
      success: false,
      reason: 'stale_observation',
    });
    expect(listener).not.toHaveBeenCalled();
  });
  it('rejects cross-workspace and detached targets before fetching', async () => {
    expect(await prSnapshotService.refreshPR({ workspaceId: 'other', prId: 'a' })).toEqual({
      success: false,
      reason: 'no_pr_url',
    });
    expect(fetchSnapshot).not.toHaveBeenCalled();
    bridge.findPR.mockResolvedValue(null);
    expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'detached' })).toEqual({
      success: false,
      reason: 'no_pr_url',
    });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
  it('refreshes every attached PR, including terminal siblings', async () => {
    bridge.listPRs.mockResolvedValue([makePR('a'), { ...makePR('b'), state: 'CLOSED' }]);
    expect((await prSnapshotService.refreshWorkspace('w')).success).toBe(true);
    expect(fetchSnapshot.mock.calls).toEqual([[makePR('a').url], [makePR('b').url]]);
  });
  it.each(['findPRContext', 'listPRs'] as const)(
    'maps %s read failures to an error result',
    async (method) => {
      bridge[method].mockRejectedValue(new Error('database unavailable'));
      await expect(prSnapshotService.refreshWorkspace('w')).resolves.toEqual({
        success: false,
        reason: 'error',
      });
      expect(fetchSnapshot).not.toHaveBeenCalled();
    }
  );
  it('continues refreshing siblings after a fetch failure', async () => {
    fetchSnapshot.mockResolvedValueOnce(null);
    expect(await prSnapshotService.refreshWorkspace('w')).toEqual({
      success: false,
      reason: 'fetch_failed',
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
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
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });
  it('does not fetch when discovery loses its claim', async () => {
    bridge.attachDiscoveredPRsIfClaimMatches.mockResolvedValue([]);
    expect(
      await prSnapshotService.attachDiscoveredPRAndRefresh('w', makePR('a').url, claim)
    ).toEqual({ success: false, reason: 'claim_stale' });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
  it('counts retained discoveries even when snapshots fail', async () => {
    fetchSnapshot.mockResolvedValue(null);
    expect(
      await prSnapshotService.attachDiscoveredPRsAndRefresh(
        'w',
        [makePR('a').url, makePR('b').url],
        claim
      )
    ).toBe(2);
  });
  it.each([undefined, null, new Date('2026-01-01')])(
    'preserves absent failure cursors and writes explicit values %s',
    async (failedAt) => {
      await prSnapshotService.recordPrObservation('w', {
        prId: 'b',
        expectedRevision: 2,
        prUrl: makePR('b').url,
        prNumber: 42,
        ciStatus: 'FAILURE',
        prState: 'OPEN',
        reviewState: null,
        hasMergeConflict: false,
        failedAt,
      });
      const written = bridge.applyPrObservationWithDispatchReset.mock.calls[0]?.[1];
      expect(written).toMatchObject({
        prId: 'b',
        expectedRevision: 2,
        expectedPrUrl: makePR('b').url,
      });
      if (failedAt === undefined) {
        expect(written).not.toHaveProperty('prCiFailedAt');
      } else {
        expect(written?.prCiFailedAt).toEqual(failedAt);
      }
    }
  );
  it('refuses mismatched identity and URL observations', async () => {
    await prSnapshotService.recordPrObservation('w', {
      prId: 'a',
      prUrl: makePR('b').url,
      prNumber: 42,
      ciStatus: 'SUCCESS',
      prState: 'OPEN',
      reviewState: null,
      hasMergeConflict: false,
    });
    expect(bridge.applyPrObservationWithDispatchReset).not.toHaveBeenCalled();
  });
  it('publishes an association update only for applied writes', async () => {
    const listener = vi.fn();
    prSnapshotService.on(PR_SNAPSHOT_UPDATED, listener);
    bridge.applyPrSnapshotWithDispatchReset
      .mockResolvedValueOnce({ applied: true, dispatchReset: true })
      .mockResolvedValueOnce({ applied: false, dispatchReset: false });
    await prSnapshotService.applySnapshot('w', snapshot, { prId: 'b' });
    await prSnapshotService.applySnapshot('w', snapshot, { prId: 'a' });
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: 'w',
        prId: 'b',
        prUrl: makePR('b').url,
      })
    );
  });
  it('requires a target for ambiguous review cursors and scopes explicit cursors', async () => {
    await prSnapshotService.recordReviewCheck('w');
    expect(bridge.applyPrSnapshotWithDispatchReset).not.toHaveBeenCalled();
    await prSnapshotService.recordReviewCheck('w', {
      prId: 'b',
      checkedAt: null,
      latestCommentId: 'comment-b',
    });
    expect(bridge.applyPrSnapshotWithDispatchReset).toHaveBeenCalledWith(
      'w',
      expect.objectContaining({
        prId: 'b',
        prReviewLastCheckedAt: null,
        prReviewLastCommentId: 'comment-b',
      })
    );
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
  it('handles fetch exceptions without publishing snapshots', async () => {
    fetchSnapshot.mockRejectedValue(new Error('offline'));
    const listener = vi.fn();
    prSnapshotService.on(PR_SNAPSHOT_UPDATED, listener);
    expect(await prSnapshotService.refreshPR({ workspaceId: 'w', prId: 'a' })).toEqual({
      success: false,
      reason: 'error',
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
