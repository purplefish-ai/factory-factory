import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prReviewRouter } from './pr-review.trpc';

function createCaller(overrides?: {
  checkHealth?: () => Promise<{ isInstalled: boolean; isAuthenticated: boolean }>;
  listReviewRequests?: () => Promise<unknown[]>;
  approvePR?: (owner: string, repo: string, number: number) => Promise<void>;
  getPRFullDetails?: (repo: string, number: number) => Promise<unknown>;
  getPRDiff?: (repo: string, number: number) => Promise<string>;
  submitReview?: (
    repo: string,
    number: number,
    action: 'approve' | 'request-changes' | 'comment',
    body?: string
  ) => Promise<void>;
}) {
  return prReviewRouter.createCaller({
    appContext: {
      services: {
        githubCLIService: {
          checkHealth:
            overrides?.checkHealth ?? (async () => ({ isInstalled: true, isAuthenticated: true })),
          listReviewRequests: overrides?.listReviewRequests ?? (async () => []),
          approvePR: overrides?.approvePR ?? (async () => undefined),
          getPRFullDetails: overrides?.getPRFullDetails ?? (async () => ({ number: 1 })),
          getPRDiff: overrides?.getPRDiff ?? (async () => 'diff --git a b'),
          submitReview: overrides?.submitReview ?? (async () => undefined),
        },
      },
    },
  } as never);
}

describe('prReviewRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty review requests when gh is unhealthy', async () => {
    const checkHealth = vi.fn(async () => ({ isInstalled: false, isAuthenticated: false }));
    const listReviewRequests = vi.fn(async () => [{ number: 1 }]);
    const caller = createCaller({ checkHealth, listReviewRequests });

    await expect(caller.listReviewRequests()).resolves.toEqual({
      prs: [],
      health: { isInstalled: false, isAuthenticated: false },
      error: null,
    });
    expect(listReviewRequests).not.toHaveBeenCalled();
  });

  it('lists review requests and handles fetch errors', async () => {
    const listReviewRequests = vi.fn(async () => [{ number: 42 }]);
    const caller = createCaller({ listReviewRequests });

    await expect(caller.listReviewRequests()).resolves.toEqual({
      prs: [{ number: 42 }],
      health: { isInstalled: true, isAuthenticated: true },
      error: null,
    });

    const failingCaller = createCaller({
      listReviewRequests: () => {
        throw new Error('gh failed');
      },
    });
    await expect(failingCaller.listReviewRequests()).resolves.toEqual({
      prs: [],
      health: { isInstalled: true, isAuthenticated: true },
      error: 'gh failed',
    });
  });

  it('delegates approve, health, details, diff, and submit review', async () => {
    const approvePR = vi.fn(async () => undefined);
    const submitReview = vi.fn(async () => undefined);
    const caller = createCaller({
      approvePR,
      submitReview,
      getPRFullDetails: async () => ({ number: 12, title: 'Fix CI' }),
      getPRDiff: async () => 'diff content',
    });

    await expect(caller.approve({ owner: 'o', repo: 'r', prNumber: 12 })).resolves.toEqual({
      success: true,
    });
    await expect(caller.checkHealth()).resolves.toEqual({
      isInstalled: true,
      isAuthenticated: true,
    });
    await expect(caller.getPRDetails({ repo: 'o/r', number: 12 })).resolves.toEqual({
      number: 12,
      title: 'Fix CI',
    });
    await expect(caller.getDiff({ repo: 'o/r', number: 12 })).resolves.toEqual({
      diff: 'diff content',
    });
    await expect(
      caller.submitReview({
        repo: 'o/r',
        number: 12,
        action: 'request-changes',
        body: 'needs work',
      })
    ).resolves.toEqual({ success: true });

    expect(approvePR).toHaveBeenCalledWith('o', 'r', 12);
    expect(submitReview).toHaveBeenCalledWith('o/r', 12, 'request-changes', 'needs work');
  });
});
