import { beforeEach, expect, it, vi } from 'vitest';

const { mockFindById, mockRefreshWorkspace, mockWarn } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockRefreshWorkspace: vi.fn(),
  mockWarn: vi.fn(),
}));
vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: { findById: mockFindById },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

import { workspaceQueryService } from './workspace-query.service';

beforeEach(() => {
  vi.resetAllMocks();
  workspaceQueryService.configure({
    session: {} as never,
    github: {} as never,
    prSnapshot: { refreshWorkspace: mockRefreshWorkspace } as never,
  });
});

it('reports aggregate state after syncing an open PR and a merged sibling', async () => {
  mockFindById.mockResolvedValue({
    id: 'mixed',
    prState: 'OPEN',
    prs: [{ id: 'a' }, { id: 'b' }],
  });
  mockRefreshWorkspace.mockResolvedValue({ success: true, snapshot: { prState: 'MERGED' } });
  const result = await workspaceQueryService.syncPRStatus('mixed');
  expect(result).toEqual({ success: true, previousPrState: 'OPEN', prState: 'OPEN' });
});

it('reports a persisted merge transition even when a sibling refresh fails', async () => {
  mockFindById
    .mockResolvedValueOnce({
      id: 'mixed',
      prState: 'OPEN',
      prs: [{ id: 'a' }, { id: 'b' }],
    })
    .mockResolvedValue({
      id: 'mixed',
      prState: 'MERGED',
      prs: [{ id: 'a' }, { id: 'b' }],
    });
  mockRefreshWorkspace.mockResolvedValue({ success: false, reason: 'fetch_failed' });
  await expect(workspaceQueryService.syncPRStatus('mixed')).resolves.toEqual({
    success: true,
    previousPrState: 'OPEN',
    prState: 'MERGED',
  });
  await expect(workspaceQueryService.syncPRStatus('mixed')).resolves.toEqual({
    success: false,
    reason: 'fetch_failed',
  });
});

it('serializes overlapping manual syncs so only one reports the merge transition', async () => {
  let state = 'OPEN';
  mockFindById.mockImplementation(async () => ({
    id: 'mixed',
    prState: state,
    prs: [{ id: 'a' }, { id: 'b' }],
  }));
  let finishRefresh!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  mockRefreshWorkspace.mockImplementation(async () => {
    await blocked;
    state = 'MERGED';
    return { success: false, reason: 'fetch_failed' };
  });
  const first = workspaceQueryService.syncPRStatus('mixed');
  await vi.waitFor(() => expect(mockRefreshWorkspace).toHaveBeenCalledTimes(1));
  const second = workspaceQueryService.syncPRStatus('mixed');
  finishRefresh();
  const results = await Promise.all([first, second]);
  expect(
    results.filter(
      (result) => result.success && result.previousPrState === 'OPEN' && result.prState === 'MERGED'
    )
  ).toHaveLength(1);
  expect(results[1]).toEqual({ success: false, reason: 'fetch_failed' });
});

it('logs a sibling refresh failure reason even when a merge transition succeeds', async () => {
  mockFindById
    .mockResolvedValueOnce({ id: 'w', prState: 'OPEN', prs: [{ id: 'a' }] })
    .mockResolvedValue({ id: 'w', prState: 'MERGED', prs: [{ id: 'a' }] });
  mockRefreshWorkspace.mockResolvedValue({ success: false, reason: 'stale_observation' });
  expect(await workspaceQueryService.syncPRStatus('w')).toMatchObject({ success: true });
  expect(mockWarn).toHaveBeenCalledWith('PR status refresh failed for one or more associations', {
    workspaceId: 'w',
    reason: 'stale_observation',
  });
});

it('does not block another workspace while a manual sync is pending', async () => {
  mockFindById.mockImplementation(async (id: string) => ({
    id,
    prState: 'OPEN',
    prs: [{ id: 'a' }],
  }));
  let finishRefresh!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  mockRefreshWorkspace.mockImplementation(async (id: string) => {
    if (id === 'slow') {
      await blocked;
    }
    return { success: true };
  });
  const slow = workspaceQueryService.syncPRStatus('slow');
  await vi.waitFor(() => expect(mockRefreshWorkspace).toHaveBeenCalledWith('slow'));
  try {
    await expect(workspaceQueryService.syncPRStatus('other')).resolves.toMatchObject({
      success: true,
    });
  } finally {
    finishRefresh();
    await slow;
  }
});

it('releases the workspace queue after a failed sync', async () => {
  mockFindById.mockResolvedValue({ id: 'w', prState: 'OPEN', prs: [{ id: 'a' }] });
  mockRefreshWorkspace
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValue({ success: true });
  const failed = workspaceQueryService.syncPRStatus('w');
  const next = workspaceQueryService.syncPRStatus('w');
  await expect(failed).rejects.toThrow('network unavailable');
  await expect(next).resolves.toMatchObject({ success: true });
});
