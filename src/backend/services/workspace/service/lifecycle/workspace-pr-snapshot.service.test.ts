import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockApplyCIObservationWithDispatchReset,
  mockApplyPrSnapshotWithDispatchReset,
  mockAttachDiscoveredPRIfClaimMatches,
  mockUpdatePRSnapshotIfUrlMatches,
} = vi.hoisted(() => ({
  mockApplyCIObservationWithDispatchReset: vi.fn(),
  mockApplyPrSnapshotWithDispatchReset: vi.fn(),
  mockAttachDiscoveredPRIfClaimMatches: vi.fn(),
  mockUpdatePRSnapshotIfUrlMatches: vi.fn(),
}));

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    applyCIObservationWithDispatchReset: (...args: unknown[]) =>
      mockApplyCIObservationWithDispatchReset(...args),
    applyPrSnapshotWithDispatchReset: (...args: unknown[]) =>
      mockApplyPrSnapshotWithDispatchReset(...args),
    attachDiscoveredPRIfClaimMatches: (...args: unknown[]) =>
      mockAttachDiscoveredPRIfClaimMatches(...args),
    updatePRSnapshotIfUrlMatches: (...args: unknown[]) => mockUpdatePRSnapshotIfUrlMatches(...args),
  },
}));

import { workspacePrSnapshotService } from './workspace-pr-snapshot.service';

describe('workspacePrSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('guards discovered PR attachment with the current discovery claim', async () => {
    const claim = {
      branchName: 'feature/discovery',
      checkedAt: new Date('2026-07-17T12:00:00.000Z'),
      retryCount: 2,
      nextCheckAt: new Date('2026-07-17T12:06:00.000Z'),
    };
    const updatedAt = new Date('2026-07-17T12:01:00.000Z');
    mockAttachDiscoveredPRIfClaimMatches.mockResolvedValue(true);

    await expect(
      workspacePrSnapshotService.attachDiscoveredPRIfClaimMatches(
        'workspace-1',
        'https://github.com/org/repo/pull/1',
        claim,
        updatedAt
      )
    ).resolves.toBe(true);

    expect(mockAttachDiscoveredPRIfClaimMatches).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/org/repo/pull/1',
      claim,
      updatedAt
    );
  });

  it('guards snapshot updates with the attached PR URL', async () => {
    const snapshot = {
      prNumber: 1,
      prState: 'OPEN' as const,
      prReviewState: null,
      prCiStatus: 'SUCCESS' as const,
    };
    const updatedAt = new Date('2026-07-17T12:02:00.000Z');
    mockUpdatePRSnapshotIfUrlMatches.mockResolvedValue(false);

    await expect(
      workspacePrSnapshotService.updatePRSnapshotIfUrlMatches(
        'workspace-1',
        'https://github.com/org/repo/pull/1',
        snapshot,
        updatedAt
      )
    ).resolves.toBe(false);

    expect(mockUpdatePRSnapshotIfUrlMatches).toHaveBeenCalledWith(
      'workspace-1',
      'https://github.com/org/repo/pull/1',
      snapshot,
      updatedAt
    );
  });

  it('owns atomic PR aggregate dispatch reset persistence', async () => {
    const observation = {
      prNumber: 1,
      prState: 'OPEN' as const,
      prReviewState: null,
      prCiStatus: 'SUCCESS' as const,
      prUpdatedAt: new Date('2026-07-17T12:03:00.000Z'),
    };

    await workspacePrSnapshotService.applyPrSnapshotWithDispatchReset('workspace-1', observation);

    expect(mockApplyPrSnapshotWithDispatchReset).toHaveBeenCalledWith('workspace-1', observation);
  });

  it('owns atomic CI observation dispatch reset persistence', async () => {
    const observation = {
      prCiStatus: 'FAILURE' as const,
      prUpdatedAt: new Date('2026-07-17T12:04:00.000Z'),
    };

    await workspacePrSnapshotService.applyCIObservationWithDispatchReset(
      'workspace-1',
      observation
    );

    expect(mockApplyCIObservationWithDispatchReset).toHaveBeenCalledWith(
      'workspace-1',
      observation
    );
  });
});
