import { describe, expect, it, vi } from 'vitest';
import type { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
}));

import { CIStatus, RatchetState } from '@/shared/core';
import type { RatchetGitHubBridge } from './bridges';
import type { PRStateInfo } from './ratchet.types';
import {
  buildFailedCheckDiagnostics,
  buildReviewSummariesForPrompt,
  computeCiSnapshotKey,
  computeDispatchSnapshotKey,
  computeLatestReviewActivityAtMs,
  determineRatchetState,
  fetchPRState,
  shouldSkipCleanPR,
} from './ratchet-pr-state.helpers';

function makePRState(overrides: Partial<PRStateInfo> = {}): PRStateInfo {
  return {
    ciStatus: CIStatus.SUCCESS,
    snapshotKey: 'key',
    hasChangesRequested: false,
    hasMergeConflict: false,
    latestReviewActivityAtMs: null,
    statusCheckRollup: null,
    prState: 'OPEN',
    prNumber: 1,
    reviewComments: [],
    ...overrides,
  };
}

describe('determineRatchetState', () => {
  it('returns MERGED when prState is MERGED', () => {
    expect(determineRatchetState(makePRState({ prState: 'MERGED' }))).toBe(RatchetState.MERGED);
  });

  it('returns IDLE when prState is CLOSED', () => {
    expect(determineRatchetState(makePRState({ prState: 'CLOSED' }))).toBe(RatchetState.IDLE);
  });

  it('returns CI_FAILED when CI has failures', () => {
    expect(determineRatchetState(makePRState({ ciStatus: CIStatus.FAILURE }))).toBe(
      RatchetState.CI_FAILED
    );
  });

  it('returns MERGE_CONFLICT when hasMergeConflict is true and CI is passing', () => {
    expect(determineRatchetState(makePRState({ hasMergeConflict: true }))).toBe(
      RatchetState.MERGE_CONFLICT
    );
  });

  it('returns MERGE_CONFLICT over CI_RUNNING when conflicts and CI is pending', () => {
    expect(
      determineRatchetState(makePRState({ hasMergeConflict: true, ciStatus: CIStatus.PENDING }))
    ).toBe(RatchetState.MERGE_CONFLICT);
  });

  it('returns MERGE_CONFLICT over CI_RUNNING when conflicts and CI is unknown', () => {
    expect(
      determineRatchetState(makePRState({ hasMergeConflict: true, ciStatus: CIStatus.UNKNOWN }))
    ).toBe(RatchetState.MERGE_CONFLICT);
  });

  it('CI_FAILED takes priority over MERGE_CONFLICT', () => {
    expect(
      determineRatchetState(makePRState({ hasMergeConflict: true, ciStatus: CIStatus.FAILURE }))
    ).toBe(RatchetState.CI_FAILED);
  });

  it('returns CI_RUNNING when CI is pending and no conflicts', () => {
    expect(determineRatchetState(makePRState({ ciStatus: CIStatus.PENDING }))).toBe(
      RatchetState.CI_RUNNING
    );
  });

  it('returns REVIEW_PENDING when changes requested and CI passed', () => {
    expect(determineRatchetState(makePRState({ hasChangesRequested: true }))).toBe(
      RatchetState.REVIEW_PENDING
    );
  });

  it('returns READY when open, CI passed, no conflicts, no review requests', () => {
    expect(determineRatchetState(makePRState())).toBe(RatchetState.READY);
  });
});

describe('shouldSkipCleanPR', () => {
  function makeWorkspace(
    overrides: { ratchetActiveSessionId: string | null } = { ratchetActiveSessionId: null }
  ) {
    return {
      id: 'ws-1',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetActiveSessionId: overrides.ratchetActiveSessionId,
    } as never;
  }

  it('does not skip a PR with merge conflicts even when CI passes', () => {
    const prState = makePRState({ hasMergeConflict: true });
    expect(shouldSkipCleanPR(makeWorkspace(), prState)).toBe(false);
  });

  it('skips a clean PR with no new review activity', () => {
    const prState = makePRState({
      latestReviewActivityAtMs: new Date('2025-12-31T00:00:00Z').getTime(),
    });
    expect(
      shouldSkipCleanPR(makeWorkspace({ ratchetActiveSessionId: 'active-session' }), prState)
    ).toBe(true);
  });

  it('skips a clean PR with stale review activity even when no fixer is active', () => {
    // The deleted 10-minute self-heal used to flip this case to "new activity";
    // dead fixers are now retried via the explicit DIED dispatch outcome instead.
    const prState = makePRState({
      latestReviewActivityAtMs: new Date('2025-12-31T00:00:00Z').getTime(),
    });
    expect(shouldSkipCleanPR(makeWorkspace(), prState)).toBe(true);
  });

  it('does not skip when CI is not passing', () => {
    const prState = makePRState({ ciStatus: CIStatus.FAILURE });
    expect(shouldSkipCleanPR(makeWorkspace(), prState)).toBe(false);
  });

  it('does not skip when changes are requested', () => {
    const prState = makePRState({ hasChangesRequested: true });
    expect(shouldSkipCleanPR(makeWorkspace(), prState)).toBe(false);
  });
});

describe('fetchPRState', () => {
  const backoff = {
    handleError: vi.fn(),
  } as unknown as RateLimitBackoff;

  function makeWorkspace() {
    return {
      id: 'ws-1',
      prUrl: 'https://github.com/example/repo/pull/123',
      prNumber: 123,
      prReviewLastCheckedAt: null,
    } as never;
  }

  function makeGitHub(overrides: Partial<RatchetGitHubBridge> = {}): RatchetGitHubBridge {
    return {
      extractPRInfo: vi.fn(() => ({ owner: 'example', repo: 'repo', number: 123 })),
      getPRFullDetails: vi.fn(),
      getReviewComments: vi.fn(),
      getResolvedReviewCommentIds: vi.fn(async () => new Set<number>()),
      computeCIStatus: vi.fn(),
      getAuthenticatedUsername: vi.fn(),
      fetchAndComputePRState: vi.fn(),
      isRecentlyFetched: vi.fn(() => false),
      isFetchInFlight: vi.fn(() => false),
      startFetch: vi.fn(() => 41),
      registerFetch: vi.fn(),
      cancelFetch: vi.fn(),
      ...overrides,
    };
  }

  it('skips GitHub API calls when the workspace was recently fetched', async () => {
    const github = makeGitHub({
      isRecentlyFetched: vi.fn(() => true),
    });

    const result = await fetchPRState({
      workspace: makeWorkspace(),
      authenticatedUsername: null,
      reviewTriggerMode: 'CHANGES_REQUESTED' as const,
      github,
      backoff,
    });

    expect(result).toEqual({ skipped: true, reason: 'recently_fetched' });
    expect(github.isRecentlyFetched).toHaveBeenCalledWith('ws-1');
    expect(github.startFetch).not.toHaveBeenCalled();
    expect(github.getPRFullDetails).not.toHaveBeenCalled();
    expect(github.getReviewComments).not.toHaveBeenCalled();
    expect(github.registerFetch).not.toHaveBeenCalled();
    expect(github.cancelFetch).not.toHaveBeenCalled();
  });

  it('fetches despite a recent fetch when bypassRecentFetchCooldown is set', async () => {
    const github = makeGitHub({
      isRecentlyFetched: vi.fn(() => true),
      getPRFullDetails: vi.fn().mockResolvedValue({
        state: 'OPEN',
        number: 123,
        url: 'https://github.com/example/repo/pull/123',
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        reviews: [],
        comments: [],
        statusCheckRollup: null,
      }),
      getReviewComments: vi.fn().mockResolvedValue([]),
      computeCIStatus: vi.fn().mockReturnValue(CIStatus.SUCCESS),
    });

    const result = await fetchPRState({
      workspace: makeWorkspace(),
      authenticatedUsername: null,
      reviewTriggerMode: 'CHANGES_REQUESTED',
      github,
      backoff,
      bypassRecentFetchCooldown: true,
    });

    if (!result || 'skipped' in result) {
      throw new Error('Expected PR state fetch to return PR details');
    }
    expect(result.prState).toBe('OPEN');
    // The bypassed fetch still claims and registers in the dedup registry.
    expect(github.startFetch).toHaveBeenCalledWith('ws-1');
    expect(github.registerFetch).toHaveBeenCalledWith('ws-1', 41);
  });

  it('still skips a bypassed fetch while another fetch is actively in flight', async () => {
    const github = makeGitHub({
      isRecentlyFetched: vi.fn(() => true),
      isFetchInFlight: vi.fn(() => true),
    });

    const result = await fetchPRState({
      workspace: makeWorkspace(),
      authenticatedUsername: null,
      reviewTriggerMode: 'CHANGES_REQUESTED',
      github,
      backoff,
      bypassRecentFetchCooldown: true,
    });

    expect(result).toEqual({ skipped: true, reason: 'recently_fetched' });
    expect(github.startFetch).not.toHaveBeenCalled();
    expect(github.getPRFullDetails).not.toHaveBeenCalled();
  });

  it('forwards cancellation, releases the fetch claim, and skips backoff', async () => {
    const controller = new AbortController();
    const timeoutError = new Error('Workspace check timed out after 1000ms');
    const github = makeGitHub({
      getPRFullDetails: vi.fn(async (_repo, _pr, signal) => {
        await Promise.resolve();
        controller.abort(timeoutError);
        signal?.throwIfAborted();
        throw new Error('unreachable');
      }),
      getReviewComments: vi.fn(
        () =>
          new Promise<never>(() => {
            // Keep the sibling request pending until Promise.all observes cancellation.
          })
      ),
    });

    await expect(
      fetchPRState({
        workspace: makeWorkspace(),
        authenticatedUsername: null,
        reviewTriggerMode: 'CHANGES_REQUESTED',
        github,
        backoff,
        signal: controller.signal,
      })
    ).rejects.toBe(timeoutError);

    expect(github.getPRFullDetails).toHaveBeenCalledWith('example/repo', 123, controller.signal);
    expect(github.getReviewComments).toHaveBeenCalledWith(
      'example/repo',
      123,
      undefined,
      controller.signal
    );
    expect(github.getResolvedReviewCommentIds).toHaveBeenCalledWith(
      'example/repo',
      123,
      controller.signal
    );
    expect(github.cancelFetch).toHaveBeenCalledWith('ws-1', 41);
    expect(backoff.handleError).not.toHaveBeenCalled();
  });
});

describe('computeDispatchSnapshotKey', () => {
  it('includes the pull request number', () => {
    const key = computeDispatchSnapshotKey(123, CIStatus.SUCCESS, false, null, null, true);

    expect(key).toBe('pr:123|ci:SUCCESS|no-changes-requested:none|merge:conflict');
  });

  it('produces different keys for identical state on different pull requests', () => {
    const first = computeDispatchSnapshotKey(123, CIStatus.SUCCESS, false, null, null, true);
    const second = computeDispatchSnapshotKey(456, CIStatus.SUCCESS, false, null, null, true);

    expect(first).not.toBe(second);
  });

  it('includes merge:conflict suffix when hasMergeConflict is true', () => {
    const key = computeDispatchSnapshotKey(123, CIStatus.SUCCESS, false, null, null, true);
    expect(key).toContain('merge:conflict');
  });

  it('includes merge:clean suffix when hasMergeConflict is false', () => {
    const key = computeDispatchSnapshotKey(123, CIStatus.SUCCESS, false, null, null, false);
    expect(key).toContain('merge:clean');
  });

  it('produces different keys for conflicted vs clean PRs', () => {
    const clean = computeDispatchSnapshotKey(123, CIStatus.PENDING, false, null, null, false);
    const conflicted = computeDispatchSnapshotKey(123, CIStatus.PENDING, false, null, null, true);
    expect(clean).not.toBe(conflicted);
  });
});

describe('computeCiSnapshotKey', () => {
  it('includes STARTUP_FAILURE checks in the failure signature', () => {
    const key = computeCiSnapshotKey(CIStatus.FAILURE, [
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'STARTUP_FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
      },
    ]);

    expect(key).toBe('ci:FAILURE:ci:STARTUP_FAILURE:100');
    expect(key).not.toBe('ci:FAILURE:unknown');
  });

  it('ignores stale failures from superseded runs of the same check', () => {
    const key = computeCiSnapshotKey(CIStatus.FAILURE, [
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
      },
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/org/repo/actions/runs/101/job/1',
      },
      {
        name: 'commitlint',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/101/job/2',
      },
    ]);

    expect(key).toContain('commitlint:FAILURE');
    expect(key).not.toContain('ci:FAILURE:100');
    expect(key).toBe('ci:FAILURE:commitlint:FAILURE:101');
  });

  it('includes STARTUP_FAILURE checks in failure snapshot keys', () => {
    const key = computeCiSnapshotKey(CIStatus.FAILURE, [
      {
        name: 'ci',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'STARTUP_FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
      },
    ]);

    expect(key).toBe('ci:FAILURE:ci:STARTUP_FAILURE:100');
  });
});

describe('fetchPRState', () => {
  function makeReviewComment(id: number, updatedAt: string) {
    return {
      id,
      author: { login: 'reviewer' },
      body: `Comment ${id}`,
      path: 'src/example.ts',
      line: 42,
      updatedAt,
      url: `https://github.com/example/repo/pull/123#discussion_r${id}`,
    };
  }

  function makeFetchGitHub(overrides: Partial<RatchetGitHubBridge> = {}): RatchetGitHubBridge {
    return {
      extractPRInfo: vi.fn().mockReturnValue({ owner: 'example', repo: 'repo', number: 123 }),
      getPRFullDetails: vi.fn().mockResolvedValue({
        state: 'OPEN',
        number: 123,
        url: 'https://github.com/example/repo/pull/123',
        reviewDecision: 'CHANGES_REQUESTED',
        mergeStateStatus: 'CLEAN',
        reviews: [],
        comments: [],
        statusCheckRollup: null,
      }),
      getReviewComments: vi.fn().mockResolvedValue([]),
      getResolvedReviewCommentIds: vi.fn(async () => new Set<number>()),
      computeCIStatus: vi.fn().mockReturnValue(CIStatus.SUCCESS),
      getAuthenticatedUsername: vi.fn(),
      fetchAndComputePRState: vi.fn(),
      isRecentlyFetched: vi.fn(() => false),
      isFetchInFlight: vi.fn(() => false),
      startFetch: vi.fn(() => 41),
      registerFetch: vi.fn(),
      cancelFetch: vi.fn(),
      ...overrides,
    };
  }

  function makeFetchParams(github: RatchetGitHubBridge) {
    return {
      workspace: {
        id: 'ws-1',
        prUrl: 'https://github.com/example/repo/pull/123',
        prNumber: 123,
        prReviewLastCheckedAt: new Date('2026-01-02T00:00:00Z'),
      } as never,
      authenticatedUsername: null,
      reviewTriggerMode: 'CHANGES_REQUESTED' as const,
      github,
      backoff: { handleError: vi.fn() } as never,
    };
  }

  function expectPRStateInfo(result: Awaited<ReturnType<typeof fetchPRState>>): PRStateInfo {
    if (!result || 'skipped' in result) {
      throw new Error('Expected PR state fetch to return PR details');
    }
    return result;
  }

  it('fetches all inline review comments even after a prior review check', async () => {
    const getReviewComments = vi
      .fn()
      .mockResolvedValue([makeReviewComment(1, '2026-01-01T00:00:00Z')]);
    const github = makeFetchGitHub({ getReviewComments });

    const result = expectPRStateInfo(await fetchPRState(makeFetchParams(github)));

    expect(getReviewComments.mock.calls[0]).toEqual(['example/repo', 123, undefined, undefined]);
    expect(result.reviewComments).toEqual([
      {
        author: 'reviewer',
        body: 'Comment 1',
        path: 'src/example.ts',
        line: 42,
        url: 'https://github.com/example/repo/pull/123#discussion_r1',
      },
    ]);
    expect(result.snapshotKey).toBe(
      'pr:123|ci:SUCCESS|changes-requested:1767225600000|merge:clean'
    );
  });

  it('filters comments in resolved threads out of the prompt payload', async () => {
    const github = makeFetchGitHub({
      getReviewComments: vi
        .fn()
        .mockResolvedValue([
          makeReviewComment(1, '2026-01-01T00:00:00Z'),
          makeReviewComment(2, '2026-01-03T00:00:00Z'),
        ]),
      getResolvedReviewCommentIds: vi.fn(async () => new Set([2])),
    });

    const result = expectPRStateInfo(await fetchPRState(makeFetchParams(github)));

    expect(result.reviewComments.map((c) => c.body)).toEqual(['Comment 1']);
    expect(github.getResolvedReviewCommentIds).toHaveBeenCalledWith('example/repo', 123, undefined);
  });

  it('keeps resolved comments in the review activity timestamp so the snapshot key stays stable', async () => {
    const github = makeFetchGitHub({
      getReviewComments: vi
        .fn()
        .mockResolvedValue([
          makeReviewComment(1, '2026-01-01T00:00:00Z'),
          makeReviewComment(2, '2026-01-03T00:00:00Z'),
        ]),
      getResolvedReviewCommentIds: vi.fn(async () => new Set([2])),
    });

    const result = expectPRStateInfo(await fetchPRState(makeFetchParams(github)));

    expect(result.latestReviewActivityAtMs).toBe(Date.parse('2026-01-03T00:00:00Z'));
    expect(result.snapshotKey).toContain(String(Date.parse('2026-01-03T00:00:00Z')));
  });

  it('includes all review comments when resolved thread lookup fails', async () => {
    const github = makeFetchGitHub({
      getReviewComments: vi
        .fn()
        .mockResolvedValue([
          makeReviewComment(1, '2026-01-01T00:00:00Z'),
          makeReviewComment(2, '2026-01-03T00:00:00Z'),
        ]),
      getResolvedReviewCommentIds: vi.fn(() => Promise.reject(new Error('GraphQL unavailable'))),
    });
    const handleError = vi.fn();
    mockLogger.warn.mockClear();
    const params = {
      ...makeFetchParams(github),
      backoff: { handleError } as unknown as RateLimitBackoff,
    };

    const result = expectPRStateInfo(await fetchPRState(params));

    expect(result.reviewComments.map((c) => c.body)).toEqual(['Comment 1', 'Comment 2']);
    expect(handleError).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to fetch resolved review threads; including all review comments',
      expect.objectContaining({ workspaceId: 'ws-1', error: 'GraphQL unavailable' })
    );
  });

  it('excludes top-level commented summaries and ordinary comments in changes-requested mode', async () => {
    const github = makeFetchGitHub({
      getPRFullDetails: vi.fn().mockResolvedValue({
        state: 'OPEN',
        number: 123,
        url: 'https://github.com/example/repo/pull/123',
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        reviews: [
          {
            author: { login: 'cubic-dev-ai' },
            state: 'COMMENTED',
            body: 'All reported issues have been addressed.',
            submittedAt: '2026-01-02T00:00:00Z',
          },
        ],
        comments: [
          {
            author: { login: 'coverage-bot' },
            updatedAt: '2026-01-03T00:00:00Z',
          },
        ],
        statusCheckRollup: null,
      }),
    });

    const result = expectPRStateInfo(await fetchPRState(makeFetchParams(github)));

    expect(result.reviewComments).toEqual([]);
    expect(result.latestReviewActivityAtMs).toBeNull();
  });

  it('includes top-level commented summaries in all-feedback mode', async () => {
    const github = makeFetchGitHub({
      getPRFullDetails: vi.fn().mockResolvedValue({
        state: 'OPEN',
        number: 123,
        url: 'https://github.com/example/repo/pull/123',
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        reviews: [
          {
            author: { login: 'reviewer' },
            state: 'COMMENTED',
            body: 'Please fix the edge case.',
            submittedAt: '2026-01-02T00:00:00Z',
          },
        ],
        comments: [],
        statusCheckRollup: null,
      }),
    });

    const result = expectPRStateInfo(
      await fetchPRState({
        ...makeFetchParams(github),
        reviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
      })
    );

    expect(result.reviewComments.map((comment) => comment.body)).toEqual([
      'Please fix the edge case.',
    ]);
    expect(result.latestReviewActivityAtMs).toBe(Date.parse('2026-01-02T00:00:00Z'));
  });
});

describe('buildReviewSummariesForPrompt', () => {
  it('includes actionable commented review bodies as prompt feedback', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'cubic-dev-ai' },
            state: 'COMMENTED',
            body: 'Please fix the hydration edge case.',
            url: 'https://github.com/example/repo/pull/1#pullrequestreview-1',
          },
        ],
      },
      null,
      'ALL_REVIEW_FEEDBACK'
    );

    expect(summaries).toEqual([
      {
        author: 'cubic-dev-ai',
        body: 'Please fix the hydration edge case.',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1#pullrequestreview-1',
      },
    ]);
  });

  it('ignores approvals, empty bodies, and the authenticated user', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'reviewer' },
            state: 'APPROVED',
            body: 'Looks good.',
          },
          {
            author: { login: 'reviewer' },
            state: 'COMMENTED',
            body: '   ',
          },
          {
            author: { login: 'me' },
            state: 'CHANGES_REQUESTED',
            body: 'My own note.',
          },
        ],
      },
      'me',
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([]);
  });

  it('excludes stale changes-requested reviews after the same reviewer approves', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'A requests changes first',
          },
          {
            author: { login: 'reviewer-b' },
            state: 'CHANGES_REQUESTED',
            body: 'B requests changes',
          },
          {
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-b',
        body: 'B requests changes',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('keeps changes-requested reviews when they are the reviewer latest state', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
          {
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'A found a later issue',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-a',
        body: 'A found a later issue',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('excludes stale changes-requested reviews when the reviewer approves then comments', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'Please fix the null check',
          },
          {
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
          {
            author: { login: 'reviewer-a' },
            state: 'COMMENTED',
            body: 'Thanks for the fix!',
          },
        ],
      },
      null,
      'ALL_REVIEW_FEEDBACK'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-a',
        body: 'Thanks for the fix!',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('keeps changes-requested reviews submitted after the reviewer last approved', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'First round of feedback',
          },
          {
            author: { login: 'reviewer-a' },
            state: 'APPROVED',
            body: '',
          },
          {
            author: { login: 'reviewer-a' },
            state: 'CHANGES_REQUESTED',
            body: 'Found a new issue after approving',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([
      {
        author: 'reviewer-a',
        body: 'Found a new issue after approving',
        path: 'PR review',
        line: null,
        url: 'https://github.com/example/repo/pull/1',
      },
    ]);
  });

  it('excludes commented review summaries in changes-requested mode', () => {
    const summaries = buildReviewSummariesForPrompt(
      {
        url: 'https://github.com/example/repo/pull/1',
        reviews: [
          {
            author: { login: 'cubic-dev-ai' },
            state: 'COMMENTED',
            body: 'Please fix the hydration edge case.',
          },
        ],
      },
      null,
      'CHANGES_REQUESTED'
    );

    expect(summaries).toEqual([]);
  });

  it('includes changes-requested summaries in both modes', () => {
    const prDetails = {
      url: 'https://github.com/example/repo/pull/1',
      reviews: [
        {
          author: { login: 'reviewer' },
          state: 'CHANGES_REQUESTED',
          body: 'Please fix this.',
        },
      ],
    };

    expect(buildReviewSummariesForPrompt(prDetails, null, 'CHANGES_REQUESTED')).toHaveLength(1);
    expect(buildReviewSummariesForPrompt(prDetails, null, 'ALL_REVIEW_FEEDBACK')).toHaveLength(1);
  });
});

describe('computeLatestReviewActivityAtMs', () => {
  const prDetails = {
    reviews: [
      {
        submittedAt: '2026-01-02T00:00:00Z',
        author: { login: 'commenting-reviewer' },
        state: 'COMMENTED',
      },
      {
        submittedAt: '2026-01-01T00:00:00Z',
        author: { login: 'changes-reviewer' },
        state: 'CHANGES_REQUESTED',
      },
    ],
    comments: [
      {
        updatedAt: '2026-01-04T00:00:00Z',
        author: { login: 'coverage-bot' },
      },
    ],
  };

  it('ignores ordinary PR comments and commented summaries in changes-requested mode', () => {
    expect(computeLatestReviewActivityAtMs(prDetails, [], null, 'CHANGES_REQUESTED')).toBe(
      Date.parse('2026-01-01T00:00:00Z')
    );
  });

  it('includes commented review submissions in all-feedback mode', () => {
    expect(computeLatestReviewActivityAtMs(prDetails, [], null, 'ALL_REVIEW_FEEDBACK')).toBe(
      Date.parse('2026-01-02T00:00:00Z')
    );
  });

  it('always includes inline review comment activity', () => {
    expect(
      computeLatestReviewActivityAtMs(
        prDetails,
        [
          {
            updatedAt: '2026-01-03T00:00:00Z',
            author: { login: 'inline-reviewer' },
          },
        ],
        null,
        'CHANGES_REQUESTED'
      )
    ).toBe(Date.parse('2026-01-03T00:00:00Z'));
  });
});

describe('buildFailedCheckDiagnostics', () => {
  it('includes STARTUP_FAILURE checks in failed check diagnostics', () => {
    const diagnostics = buildFailedCheckDiagnostics(
      makePRState({
        statusCheckRollup: [
          {
            name: 'ci',
            workflowName: 'CI',
            status: 'COMPLETED',
            conclusion: 'STARTUP_FAILURE',
            detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
          },
        ],
      })
    );

    expect(diagnostics).toEqual([
      {
        name: 'ci',
        status: 'COMPLETED',
        conclusion: 'STARTUP_FAILURE',
        runId: '100',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
      },
    ]);
  });
});

describe('buildFailedCheckDiagnostics', () => {
  it('includes STARTUP_FAILURE checks in failed check diagnostics', () => {
    const diagnostics = buildFailedCheckDiagnostics(
      makePRState({
        statusCheckRollup: [
          {
            name: 'ci',
            workflowName: 'CI',
            status: 'COMPLETED',
            conclusion: 'STARTUP_FAILURE',
            detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
          },
        ],
      })
    );

    expect(diagnostics).toEqual([
      {
        name: 'ci',
        status: 'COMPLETED',
        conclusion: 'STARTUP_FAILURE',
        runId: '100',
        detailsUrl: 'https://github.com/org/repo/actions/runs/100/job/1',
      },
    ]);
  });
});
