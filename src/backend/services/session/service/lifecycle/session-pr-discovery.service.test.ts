import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/backend/services/logger.service';

const { mockAttachAndRefreshPR, mockFindPRForBranch, mockResetPRDiscoveryBackoff } = vi.hoisted(
  () => ({
    mockAttachAndRefreshPR: vi.fn(),
    mockFindPRForBranch: vi.fn(),
    mockResetPRDiscoveryBackoff: vi.fn(),
  })
);

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    findPRForBranch: (...args: unknown[]) => mockFindPRForBranch(...args),
  },
  prSnapshotService: {
    attachAndRefreshPR: (...args: unknown[]) => mockAttachAndRefreshPR(...args),
  },
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceAccessor: {
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
    expect(mockFindPRForBranch).not.toHaveBeenCalled();
    expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
  });
});
