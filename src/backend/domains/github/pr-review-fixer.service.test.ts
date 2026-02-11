import { describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { prReviewFixerService } from './pr-review-fixer.service';

describe('PRReviewFixerService', () => {
  it('returns an error result when not configured instead of throwing', async () => {
    const result = await prReviewFixerService.triggerReviewFix({
      workspaceId: 'w1',
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
      commentDetails: {
        reviews: [],
        comments: [],
      },
    });

    expect(result).toEqual({
      status: 'error',
      error: expect.stringContaining('not configured'),
    });
  });
});
