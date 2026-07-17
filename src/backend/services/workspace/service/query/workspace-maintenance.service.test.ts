import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindNeedingPRDiscovery = vi.fn();
const mockClaimPRDiscoveryAttempt = vi.fn();

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findNeedingPRDiscovery: (...args: unknown[]) => mockFindNeedingPRDiscovery(...args),
    claimPRDiscoveryAttempt: (...args: unknown[]) => mockClaimPRDiscoveryAttempt(...args),
  },
}));

import { workspaceMaintenanceService } from './workspace-maintenance.service';

describe('workspaceMaintenanceService PR discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards discovery limits and due time to the owning accessor', async () => {
    const dueAt = new Date('2026-07-17T12:00:00.000Z');
    mockFindNeedingPRDiscovery.mockResolvedValue([]);

    await workspaceMaintenanceService.findNeedingPRDiscovery(25, dueAt);

    expect(mockFindNeedingPRDiscovery).toHaveBeenCalledWith(25, dueAt);
  });

  it('forwards compare-and-set claim inputs to the owning accessor', async () => {
    const checkedAt = new Date('2026-07-17T12:00:00.000Z');
    const attempt = {
      branchName: 'feature',
      expectedUpdatedAt: new Date('2026-07-17T11:00:00.000Z'),
      expectedRetryCount: 1,
      expectedNextCheckAt: new Date('2026-07-17T11:55:00.000Z'),
      checkedAt,
      nextCheckAt: new Date('2026-07-17T12:02:00.000Z'),
    };
    mockClaimPRDiscoveryAttempt.mockResolvedValue(true);

    await expect(
      workspaceMaintenanceService.claimPRDiscoveryAttempt('workspace-1', attempt)
    ).resolves.toBe(true);
    expect(mockClaimPRDiscoveryAttempt).toHaveBeenCalledWith('workspace-1', attempt);
  });
});
