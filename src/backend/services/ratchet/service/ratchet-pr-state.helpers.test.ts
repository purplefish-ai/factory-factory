import { describe, expect, it, vi } from 'vitest';
import type { RateLimitBackoff } from '@/backend/services/rate-limit-backoff';
import { CIStatus, RatchetState } from '@/shared/core';
import type { RatchetGitHubBridge } from './bridges';
import type { PRStateInfo } from './ratchet.types';
import {
  buildFailedCheckDiagnostics,
  buildReviewSummariesForPrompt,
  computeCiSnapshotKey,
  computeDispatchSnapshotKey,
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
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;

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
      computeCIStatus: vi.fn(),
      getAuthenticatedUsername: vi.fn(),
      fetchAndComputePRState: vi.fn(),
      isRecentlyFetched: vi.fn(() => false),
      startFetch: vi.fn(),
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
      github,
      backoff,
      logger,
    });

    expect(result).toEqual({ skipped: true, reason: 'recently_fetched' });
    expect(github.isRecentlyFetched).toHaveBeenCalledWith('ws-1');
    expect(github.startFetch).not.toHaveBeenCalled();
    expect(github.getPRFullDetails).not.toHaveBeenCalled();
    expect(github.getReviewComments).not.toHaveBeenCalled();
    expect(github.registerFetch).not.toHaveBeenCalled();
    expect(github.cancelFetch).not.toHaveBeenCalled();
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
            // Keep the sibling GitHub request pending until cancellation rejects Promise.all.
          })
      ),
    });

    await expect(
      fetchPRState({
        workspace: makeWorkspace(),
        authenticatedUsername: null,
        github,
        backoff,
        logger,
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
    expect(github.cancelFetch).toHaveBeenCalledWith('ws-1');
    expect(backoff.handleError).not.toHaveBeenCalled();
  });
});

describe('computeDispatchSnapshotKey', () => {
  it('includes merge:conflict suffix when hasMergeConflict is true', () => {
    const key = computeDispatchSnapshotKey(CIStatus.SUCCESS, false, null, null, true);
    expect(key).toContain('merge:conflict');
  });

  it('includes merge:clean suffix when hasMergeConflict is false', () => {
    const key = computeDispatchSnapshotKey(CIStatus.SUCCESS, false, null, null, false);
    expect(key).toContain('merge:clean');
  });

  it('produces different keys for conflicted vs clean PRs', () => {
    const clean = computeDispatchSnapshotKey(CIStatus.PENDING, false, null, null, false);
    const conflicted = computeDispatchSnapshotKey(CIStatus.PENDING, false, null, null, true);
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
  it('fetches all inline review comments even after a prior review check', async () => {
    const getReviewComments = vi.fn().mockResolvedValue([
      {
        author: { login: 'reviewer' },
        body: 'Please handle this edge case.',
        path: 'src/example.ts',
        line: 42,
        updatedAt: '2026-01-01T00:00:00Z',
        url: 'https://github.com/example/repo/pull/123#discussion_r1',
      },
    ]);
    const github = {
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
      getReviewComments,
      computeCIStatus: vi.fn().mockReturnValue(CIStatus.SUCCESS),
      getAuthenticatedUsername: vi.fn(),
      fetchAndComputePRState: vi.fn(),
      isRecentlyFetched: vi.fn(() => false),
      startFetch: vi.fn(),
      registerFetch: vi.fn(),
      cancelFetch: vi.fn(),
    };

    const result = await fetchPRState({
      workspace: {
        id: 'ws-1',
        prUrl: 'https://github.com/example/repo/pull/123',
        prNumber: 123,
        prReviewLastCheckedAt: new Date('2026-01-02T00:00:00Z'),
      } as never,
      authenticatedUsername: null,
      github,
      backoff: { handleError: vi.fn() } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(getReviewComments.mock.calls[0]).toEqual(['example/repo', 123, undefined, undefined]);
    if (!result || 'skipped' in result) {
      throw new Error('Expected PR state fetch to return PR details');
    }

    expect(result.reviewComments).toEqual([
      {
        author: 'reviewer',
        body: 'Please handle this edge case.',
        path: 'src/example.ts',
        line: 42,
        url: 'https://github.com/example/repo/pull/123#discussion_r1',
      },
    ]);
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
      null
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
      'me'
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
      null
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
      null
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
      null
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
      null
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
