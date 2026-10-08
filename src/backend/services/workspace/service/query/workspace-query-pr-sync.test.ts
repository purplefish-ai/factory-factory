import { expect, it, vi } from 'vitest';

const { mockFindById, mockRefreshWorkspace } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockRefreshWorkspace: vi.fn(),
}));
vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: { findById: mockFindById },
}));

import { workspaceQueryService } from './workspace-query.service';

it('reports aggregate state after syncing an open PR and a merged sibling', async () => {
  workspaceQueryService.configure({
    session: {} as never,
    github: {} as never,
    prSnapshot: { refreshWorkspace: mockRefreshWorkspace } as never,
  });
  mockFindById.mockResolvedValue({
    id: 'mixed',
    prState: 'OPEN',
    prs: [{ id: 'a' }, { id: 'b' }],
  });
  mockRefreshWorkspace.mockResolvedValue({ success: true, snapshot: { prState: 'MERGED' } });
  const result = await workspaceQueryService.syncPRStatus('mixed');
  expect(result).toEqual({ success: true, previousPrState: 'OPEN', prState: 'OPEN' });
});
