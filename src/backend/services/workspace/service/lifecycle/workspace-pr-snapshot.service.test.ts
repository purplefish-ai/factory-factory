import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAttachDiscoveredPRIfClaimMatches } = vi.hoisted(() => ({
  mockAttachDiscoveredPRIfClaimMatches: vi.fn(),
}));

vi.mock('@/backend/services/workspace/resources/workspace-pr.accessor', () => ({
  workspacePrAccessor: {
    attachDiscoveredPRIfClaimMatches: (...args: unknown[]) =>
      mockAttachDiscoveredPRIfClaimMatches(...args),
  },
}));

import { workspacePrSnapshotService } from './workspace-pr-snapshot.service';

describe('workspacePrSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('guards discovered PR attachment with the current discovery claim', async () => {
    const claim = {
      githubOwner: 'org',
      githubRepo: 'repo',
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
});
