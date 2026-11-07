import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logger }));
vi.mock('@/backend/services/workspace', () => ({
  APP_PRIVATE_REF_PREFIX: 'refs/factory-factory/',
  gitOpsService: {},
}));

import {
  type PrepareReviewCheckoutInput,
  prepareReviewCheckout,
  type ReviewCheckoutGit,
  reviewRefForPr,
} from './adversarial-review-checkout-context';

const HEAD_SHA = 'a'.repeat(40);
const LOCAL_SHA = 'b'.repeat(40);

const INPUT: PrepareReviewCheckoutInput = {
  worktreePath: '/tmp/worktree',
  repo: 'Example/Repo',
  prNumber: 42,
  prId: 'pr-1',
  headSha: HEAD_SHA,
  headRefName: 'feature/x',
};

function createGit(overrides: Partial<ReviewCheckoutGit> = {}) {
  return {
    getCheckoutIdentity: vi.fn<ReviewCheckoutGit['getCheckoutIdentity']>().mockResolvedValue({
      branch: 'feature/x',
      headSha: HEAD_SHA,
      hasLocalChanges: false,
      origin: { owner: 'example', repo: 'repo' },
    }),
    isAncestorCommit: vi.fn<ReviewCheckoutGit['isAncestorCommit']>().mockResolvedValue(true),
    hasCommit: vi.fn<ReviewCheckoutGit['hasCommit']>().mockResolvedValue(true),
    fetchPullRequestHead: vi
      .fn<ReviewCheckoutGit['fetchPullRequestHead']>()
      .mockResolvedValue(undefined),
    deletePrivateRef: vi.fn<ReviewCheckoutGit['deletePrivateRef']>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('prepareReviewCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the working tree when it has the PR branch at the PR head', async () => {
    const git = createGit();

    const { context, cleanup } = await prepareReviewCheckout(INPUT, git);
    await cleanup();

    expect(context).toEqual({
      kind: 'checked_out',
      headSha: HEAD_SHA,
      localHeadSha: HEAD_SHA,
      hasLocalChanges: false,
    });
    expect(git.fetchPullRequestHead).not.toHaveBeenCalled();
    expect(git.deletePrivateRef).not.toHaveBeenCalled();
  });

  it('keeps the checkout when the local branch is ahead of the PR head', async () => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockResolvedValue({
        branch: 'feature/x',
        headSha: LOCAL_SHA,
        hasLocalChanges: false,
        origin: { owner: 'example', repo: 'repo' },
      }),
    });

    const { context } = await prepareReviewCheckout(INPUT, git);

    expect(context).toEqual({
      kind: 'checked_out',
      headSha: HEAD_SHA,
      localHeadSha: LOCAL_SHA,
      hasLocalChanges: false,
    });
    // The PR head must be reachable from the local HEAD, not the other way round.
    expect(git.isAncestorCommit).toHaveBeenCalledWith('/tmp/worktree', HEAD_SHA, LOCAL_SHA);
  });

  it.each([
    ['has uncommitted changes', true, true],
    ['status is unknown', null, true],
  ])('reports local changes when the checked-out PR branch %s', async (_name, dirty, expected) => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockResolvedValue({
        branch: 'feature/x',
        headSha: HEAD_SHA,
        hasLocalChanges: dirty,
        origin: { owner: 'example', repo: 'repo' },
      }),
    });

    const { context } = await prepareReviewCheckout(INPUT, git);

    expect(context).toEqual({
      kind: 'checked_out',
      headSha: HEAD_SHA,
      localHeadSha: HEAD_SHA,
      hasLocalChanges: expected,
    });
  });

  it.each([
    ['another branch is checked out', { branch: 'main' }, true],
    ['HEAD is detached', { branch: null }, true],
    ['the branch name matches but lacks the PR head', { branch: 'feature/x' }, false],
  ])('fetches the PR head when %s', async (_name, identity, isAncestor) => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockResolvedValue({
        headSha: LOCAL_SHA,
        origin: { owner: 'example', repo: 'repo' },
        ...identity,
      }),
      isAncestorCommit: vi.fn().mockResolvedValue(isAncestor),
    });

    const { context, cleanup } = await prepareReviewCheckout(INPUT, git);

    expect(context).toEqual({
      kind: 'fetched_head',
      headSha: HEAD_SHA,
      worktreeBranch: identity.branch,
    });
    expect(git.fetchPullRequestHead).toHaveBeenCalledWith(
      '/tmp/worktree',
      42,
      'refs/factory-factory/review/pr-1'
    );
    expect(git.hasCommit).toHaveBeenCalledWith('/tmp/worktree', HEAD_SHA);

    await cleanup();
    expect(git.deletePrivateRef).toHaveBeenCalledWith(
      '/tmp/worktree',
      'refs/factory-factory/review/pr-1'
    );
  });

  it('treats an ancestry check failure as not checked out', async () => {
    const git = createGit({ isAncestorCommit: vi.fn().mockRejectedValue(new Error('bad object')) });

    const { context } = await prepareReviewCheckout(INPUT, git);

    expect(context.kind).toBe('fetched_head');
  });

  it.each([
    ['origin is a different repository', { owner: 'someone', repo: 'fork' }, 'other_repository'],
    ['origin is missing or not a GitHub remote', null, 'unknown_origin'],
  ] as const)('limits the review to the diff when %s', async (_name, origin, reason) => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockResolvedValue({
        branch: 'feature/x',
        headSha: HEAD_SHA,
        hasLocalChanges: false,
        origin,
      }),
    });

    const { context } = await prepareReviewCheckout(INPUT, git);

    expect(context).toEqual({ kind: 'diff_only', headSha: HEAD_SHA, reason });
    expect(git.fetchPullRequestHead).not.toHaveBeenCalled();
  });

  it('limits the review to the diff when the worktree cannot be inspected', async () => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockRejectedValue(new Error('not a git repository')),
    });

    const { context } = await prepareReviewCheckout(INPUT, git);

    expect(context).toEqual({ kind: 'diff_only', headSha: HEAD_SHA, reason: 'git_unavailable' });
  });

  it('falls back to the diff and still cleans up when the fetch fails', async () => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockResolvedValue({
        branch: 'main',
        headSha: LOCAL_SHA,
        origin: { owner: 'example', repo: 'repo' },
      }),
      fetchPullRequestHead: vi.fn().mockRejectedValue(new Error('authentication failed')),
    });

    const { context, cleanup } = await prepareReviewCheckout(INPUT, git);
    await cleanup();

    expect(context).toEqual({ kind: 'diff_only', headSha: HEAD_SHA, reason: 'fetch_failed' });
    expect(git.deletePrivateRef).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Falling back to a diff-only adversarial review',
      expect.objectContaining({ error: 'authentication failed' })
    );
  });

  it('falls back to the diff when the PR moved on after its diff was read', async () => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockResolvedValue({
        branch: 'main',
        headSha: LOCAL_SHA,
        origin: { owner: 'example', repo: 'repo' },
      }),
      hasCommit: vi.fn().mockResolvedValue(false),
    });

    const { context } = await prepareReviewCheckout(INPUT, git);

    expect(context).toEqual({ kind: 'diff_only', headSha: HEAD_SHA, reason: 'fetch_failed' });
  });

  it('logs instead of throwing when ref cleanup fails', async () => {
    const git = createGit({
      getCheckoutIdentity: vi.fn().mockResolvedValue({
        branch: 'main',
        headSha: LOCAL_SHA,
        origin: { owner: 'example', repo: 'repo' },
      }),
      deletePrivateRef: vi.fn().mockRejectedValue(new Error('locked')),
    });

    const { cleanup } = await prepareReviewCheckout(INPUT, git);

    await expect(cleanup()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to delete adversarial review ref',
      expect.objectContaining({ error: 'locked' })
    );
  });

  it('rejects a malformed PR head SHA', async () => {
    await expect(
      prepareReviewCheckout({ ...INPUT, headSha: 'HEAD; rm -rf /' }, createGit())
    ).rejects.toThrow('Invalid PR head SHA');
  });
});

describe('reviewRefForPr', () => {
  it('keeps ref names inside the private namespace', () => {
    expect(reviewRefForPr('cm9abc_DEF-1')).toBe('refs/factory-factory/review/cm9abc_DEF-1');
    expect(reviewRefForPr('../../heads/main')).toBe('refs/factory-factory/review/______heads_main');
  });
});
