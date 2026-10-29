import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prReviewRouter } from './pr-review.trpc';

function createCaller(overrides?: {
  checkHealth?: () => Promise<{ isInstalled: boolean; isAuthenticated: boolean }>;
  listReviewRequests?: (repository?: string) => Promise<unknown[]>;
  findProject?: (id: string) => Promise<unknown>;
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
        projectManagementService: { findById: overrides?.findProject ?? (async () => null) },
        listVisibleReviewRequests: overrides?.listReviewRequests ?? (async () => []),
        githubCLIService: {
          checkHealth:
            overrides?.checkHealth ?? (async () => ({ isInstalled: true, isAuthenticated: true })),
          listReviewRequests: overrides?.listReviewRequests ?? (async () => []),
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

  it('delegates details, diff, and submit review', async () => {
    const submitReview = vi.fn(async () => undefined);
    const caller = createCaller({
      submitReview,
      getPRFullDetails: async () => ({ number: 12, title: 'Fix CI' }),
      getPRDiff: async () => 'diff content',
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

    expect(submitReview).toHaveBeenCalledWith('o/r', 12, 'request-changes', 'needs work');
  });
});

describe('project-scoped reviews', () => {
  it('resolves repository from the project, without changing global callers', async () => {
    const listReviewRequests = vi.fn(async () => [{ number: 7 }]);
    const findProject = vi.fn(async () => ({ githubOwner: 'Owner', githubRepo: 'Repo' }));
    const caller = createCaller({ listReviewRequests, findProject });
    expect((await caller.listReviewRequests({ projectId: 'p' })).prs).toEqual([{ number: 7 }]);
    expect(findProject).toHaveBeenCalledWith('p');
    expect(listReviewRequests).toHaveBeenCalledWith('Owner/Repo');
    await caller.listReviewRequests();
    expect(listReviewRequests).toHaveBeenLastCalledWith(undefined);
  });

  it.each([
    [null, 'Project not found'],
    [{ githubOwner: null, githubRepo: 'repo' }, 'Project is not linked to a GitHub repository'],
    [{ githubOwner: 'owner', githubRepo: null }, 'Project is not linked to a GitHub repository'],
    [{ githubOwner: 'owner', githubRepo: 'repo repo:foreign/repo' }, 'Invalid GitHub repository'],
  ])(
    'never falls back to global reviews for invalid project metadata %j',
    async (project, error) => {
      const listReviewRequests = vi.fn(async () => [{ number: 7 }]);
      const caller = createCaller({ listReviewRequests, findProject: async () => project });
      expect(await caller.listReviewRequests({ projectId: 'p' })).toMatchObject({ prs: [], error });
      expect(listReviewRequests).not.toHaveBeenCalled();
    }
  );

  it('short circuits unauthenticated scoped requests and handles project lookup failures', async () => {
    const findProject = vi.fn(() => Promise.reject(new Error('lookup failed')));
    const caller = createCaller({ findProject });
    expect((await caller.listReviewRequests({ projectId: 'p' })).error).toBe('lookup failed');
    findProject.mockClear();
    const unhealthy = createCaller({
      findProject,
      checkHealth: async () => ({ isInstalled: true, isAuthenticated: false }),
    });
    expect(await unhealthy.listReviewRequests({ projectId: 'p' })).toMatchObject({
      prs: [],
      error: null,
    });
    expect(findProject).not.toHaveBeenCalled();
  });
});
