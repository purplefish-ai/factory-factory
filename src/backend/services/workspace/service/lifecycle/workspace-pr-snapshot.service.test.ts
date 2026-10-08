import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApplyCIObservationWithDispatchReset, mockApplyPrSnapshotWithDispatchReset } =
  vi.hoisted(() => ({
    mockApplyCIObservationWithDispatchReset: vi.fn(),
    mockApplyPrSnapshotWithDispatchReset: vi.fn(),
  }));

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    applyPrObservationWithDispatchReset: (...args: unknown[]) =>
      mockApplyCIObservationWithDispatchReset(...args),
    applyPrSnapshotWithDispatchReset: (...args: unknown[]) =>
      mockApplyPrSnapshotWithDispatchReset(...args),
  },
}));

import { workspacePrSnapshotService } from './workspace-pr-snapshot.service';

describe('workspacePrSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expectedPrUrl: 'https://github.com/org/repo/pull/7',
      expectedPrNumber: 7,
      prCiStatus: 'FAILURE' as const,
      prState: 'OPEN' as const,
      prReviewState: null,
      prHasMergeConflict: false,
      prUpdatedAt: new Date('2026-07-17T12:04:00.000Z'),
    };

    await workspacePrSnapshotService.applyPrObservationWithDispatchReset(
      'workspace-1',
      observation
    );

    expect(mockApplyCIObservationWithDispatchReset).toHaveBeenCalledWith(
      'workspace-1',
      observation
    );
  });
});
