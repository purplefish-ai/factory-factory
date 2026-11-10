import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/backend/services/logger.service';

const { mockResetPRDiscoveryBackoff } = vi.hoisted(() => ({
  mockResetPRDiscoveryBackoff: vi.fn(),
}));

import { schedulePRDiscovery } from './session-pr-discovery.service';

describe('schedulePRDiscovery', () => {
  const logger = createLogger('session-pr-discovery-test');

  beforeEach(() => {
    vi.clearAllMocks();
    mockResetPRDiscoveryBackoff.mockResolvedValue(true);
  });

  it('resets persisted discovery backoff without performing GitHub discovery', async () => {
    await schedulePRDiscovery('workspace-1', logger, {
      resetPRDiscoveryBackoff: mockResetPRDiscoveryBackoff,
    });

    expect(mockResetPRDiscoveryBackoff).toHaveBeenCalledOnce();
    expect(mockResetPRDiscoveryBackoff).toHaveBeenCalledWith('workspace-1');
  });

  it('logs and suppresses reset failures', async () => {
    const error = new Error('database unavailable');
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    mockResetPRDiscoveryBackoff.mockRejectedValue(error);

    await expect(
      schedulePRDiscovery('workspace-1', logger, {
        resetPRDiscoveryBackoff: mockResetPRDiscoveryBackoff,
      })
    ).resolves.toBeUndefined();

    expect(debug).toHaveBeenCalledWith('PR discovery backoff reset failed', {
      workspaceId: 'workspace-1',
      error: 'database unavailable',
    });
  });
});
