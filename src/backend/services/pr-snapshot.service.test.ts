import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockFetchAndComputePRState = vi.fn();
const mockUpdateCachedKanbanColumn = vi.fn();

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock('./github-cli.service', () => ({
  githubCLIService: {
    fetchAndComputePRState: (...args: unknown[]) => mockFetchAndComputePRState(...args),
  },
}));

vi.mock('./kanban-state.service', () => ({
  kanbanStateService: {
    updateCachedKanbanColumn: (...args: unknown[]) => mockUpdateCachedKanbanColumn(...args),
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { prSnapshotService } from './pr-snapshot.service';

describe('PRSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns workspace_not_found when workspace does not exist', async () => {
    mockFindById.mockResolvedValue(null);

    const result = await prSnapshotService.refreshWorkspace('w1');

    expect(result).toEqual({ success: false, reason: 'workspace_not_found' });
  });

  it('returns no_pr_url when workspace has no PR URL', async () => {
    mockFindById.mockResolvedValue({ id: 'w1', prUrl: null });

    const result = await prSnapshotService.refreshWorkspace('w1');

    expect(result).toEqual({ success: false, reason: 'no_pr_url' });
  });

  it('returns fetch_failed when GitHub snapshot is unavailable', async () => {
    mockFindById.mockResolvedValue({ id: 'w1', prUrl: 'https://github.com/org/repo/pull/1' });
    mockFetchAndComputePRState.mockResolvedValue(null);

    const result = await prSnapshotService.refreshWorkspace('w1');

    expect(result).toEqual({ success: false, reason: 'fetch_failed' });
  });

  it('persists PR snapshot and updates kanban cache', async () => {
    mockFetchAndComputePRState.mockResolvedValue({
      prNumber: 123,
      prState: 'OPEN',
      prReviewState: 'APPROVED',
      prCiStatus: 'SUCCESS',
    });

    const result = await prSnapshotService.refreshWorkspace(
      'w1',
      'https://github.com/org/repo/pull/123'
    );

    expect(result).toEqual({
      success: true,
      snapshot: {
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'SUCCESS',
      },
    });

    expect(mockUpdate).toHaveBeenCalledWith('w1', {
      prNumber: 123,
      prState: 'OPEN',
      prReviewState: 'APPROVED',
      prCiStatus: 'SUCCESS',
      prUpdatedAt: expect.any(Date),
    });
    expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w1');
  });

  it('applies snapshot directly through shared write path', async () => {
    await prSnapshotService.applySnapshot('w2', {
      prNumber: 50,
      prState: 'MERGED',
      prReviewState: null,
      prCiStatus: 'SUCCESS',
    });

    expect(mockUpdate).toHaveBeenCalledWith('w2', {
      prNumber: 50,
      prState: 'MERGED',
      prReviewState: null,
      prCiStatus: 'SUCCESS',
      prUpdatedAt: expect.any(Date),
    });
    expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w2');
  });
});
