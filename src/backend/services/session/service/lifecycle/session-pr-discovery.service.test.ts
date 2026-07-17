import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/backend/services/logger.service';

const { mockResetPRDiscoveryBackoff } = vi.hoisted(() => ({
  mockResetPRDiscoveryBackoff: vi.fn(),
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {
    resetPRDiscoveryBackoff: (...args: unknown[]) => mockResetPRDiscoveryBackoff(...args),
  },
}));

import { maybeDiscoverPROnSessionEnd } from './session-pr-discovery.service';

describe('maybeDiscoverPROnSessionEnd', () => {
  const logger = createLogger('session-pr-discovery-test');

  beforeEach(() => {
    vi.clearAllMocks();
    mockResetPRDiscoveryBackoff.mockResolvedValue(true);
  });

  it('resets persisted discovery backoff without performing GitHub discovery', async () => {
    await maybeDiscoverPROnSessionEnd('workspace-1', logger);

    expect(mockResetPRDiscoveryBackoff).toHaveBeenCalledOnce();
    expect(mockResetPRDiscoveryBackoff).toHaveBeenCalledWith('workspace-1');
  });

  it('logs and suppresses reset failures', async () => {
    const error = new Error('database unavailable');
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    mockResetPRDiscoveryBackoff.mockRejectedValue(error);

    await expect(maybeDiscoverPROnSessionEnd('workspace-1', logger)).resolves.toBeUndefined();

    expect(debug).toHaveBeenCalledWith('PR discovery backoff reset on session end failed', {
      workspaceId: 'workspace-1',
      error: 'database unavailable',
    });
  });
});
