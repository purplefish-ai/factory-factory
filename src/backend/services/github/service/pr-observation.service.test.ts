import { beforeEach, expect, it, vi } from 'vitest';
import { GitHubConnectivityError } from '@/backend/lib/github-cli-error';
import { ADVERSARIAL_REVIEW_MARKER } from '@/shared/adversarial-review';
import type { PRWithFullDetails } from '@/shared/github-types';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { githubCLIService } from './github-cli.service';
import { prObservationService } from './pr-observation.service';

function fullDetails(overrides: Partial<PRWithFullDetails> = {}): PRWithFullDetails {
  return {
    number: 1,
    title: 'PR',
    url: redObservation.url,
    author: { login: 'me' },
    repository: { name: 'repo', nameWithOwner: 'org/repo' },
    createdAt: redObservation.observedAt,
    updatedAt: redObservation.observedAt,
    isDraft: false,
    state: 'OPEN',
    reviewDecision: null,
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/org/repo/actions/runs/1',
      },
    ],
    reviews: [],
    comments: [],
    labels: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefName: 'feature',
    headRefOid: 'sha',
    baseRefName: 'main',
    mergeStateStatus: 'DIRTY',
    ...overrides,
  };
}

const target = { workspaceId: 'w', prId: 'p' };
const reviewerComment = {
  id: 2,
  author: { login: 'reviewer' },
  body: 'Please fix',
  path: 'src/file.ts',
  line: 2,
  url: redObservation.url,
  createdAt: redObservation.observedAt,
  updatedAt: redObservation.observedAt,
};
/** Core facts come from the combined read with reviews, or the core read without. */
function mockCore(details: PRWithFullDetails) {
  vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue(details);
  vi.mocked(githubCLIService.getPRObservationDetails).mockResolvedValue(details);
}
let clock = Date.now();
const readPolicy = vi.fn(async () => ({ reviewTriggerMode: 'CHANGES_REQUESTED' as const }));

beforeEach(() => {
  // Each test starts beyond the identity cache TTL; production still caches successes.
  clock += 300_001;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  readPolicy.mockReset().mockResolvedValue({ reviewTriggerMode: 'CHANGES_REQUESTED' });
  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url }),
    readPolicy,
  });
  vi.spyOn(githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('me');
  vi.spyOn(githubCLIService, 'getPRStatusDetails').mockResolvedValue(fullDetails());
  vi.spyOn(githubCLIService, 'getPRObservationDetails').mockResolvedValue(fullDetails());
  vi.spyOn(githubCLIService, 'getPRReviews').mockResolvedValue([]);
  vi.spyOn(githubCLIService, 'getReviewComments').mockResolvedValue([]);
  vi.spyOn(githubCLIService, 'getResolvedReviewCommentIds').mockResolvedValue(new Set());
});

it('accepts core CI facts with unknown GitHub identity and retries enrichment next time', async () => {
  const lookup = vi
    .mocked(githubCLIService.getAuthenticatedUsername)
    .mockResolvedValueOnce(null)
    .mockResolvedValue('me');
  vi.mocked(githubCLIService.getReviewComments).mockResolvedValue([
    {
      id: 1,
      author: { login: 'me' },
      body: 'Own feedback',
      path: 'src/file.ts',
      line: 1,
      url: redObservation.url,
      createdAt: redObservation.observedAt,
      updatedAt: redObservation.observedAt,
    },
    reviewerComment,
  ]);
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    ciStatus: 'FAILURE',
    reviewsComplete: false,
    actionableReviews: [],
    resolvedReviewIds: [],
  });
  expect(githubCLIService.getPRObservationDetails).toHaveBeenCalledTimes(1);
  expect(githubCLIService.getPRStatusDetails).not.toHaveBeenCalled();
  expect(githubCLIService.getPRReviews).not.toHaveBeenCalled();
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    reviewsComplete: true,
    actionableReviews: [expect.objectContaining({ identity: 'comment:2', author: 'reviewer' })],
  });
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('reads only core PR facts when review data is not requested', async () => {
  vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue(
    fullDetails({ reviewDecision: 'CHANGES_REQUESTED' })
  );
  await expect(
    prObservationService.fetch(target, undefined, { includeReviews: false })
  ).resolves.toMatchObject({
    ciStatus: 'FAILURE',
    hasMergeConflict: true,
    prState: 'CHANGES_REQUESTED',
    reviewState: 'CHANGES_REQUESTED',
    reviewsComplete: false,
    actionableReviews: [],
    resolvedReviewIds: [],
  });
  expect(githubCLIService.getPRStatusDetails).toHaveBeenCalledOnce();
  expect(readPolicy).not.toHaveBeenCalled();
  expect(githubCLIService.getAuthenticatedUsername).not.toHaveBeenCalled();
  expect(githubCLIService.getPRObservationDetails).not.toHaveBeenCalled();
  expect(githubCLIService.getPRReviews).not.toHaveBeenCalled();
  expect(githubCLIService.getReviewComments).not.toHaveBeenCalled();
  expect(githubCLIService.getResolvedReviewCommentIds).not.toHaveBeenCalled();
});

it('reads review data by default and when requested', async () => {
  vi.mocked(githubCLIService.getReviewComments).mockResolvedValue([reviewerComment]);
  await prObservationService.fetch(target);
  await prObservationService.fetch(target, undefined, { includeReviews: true });
  expect(githubCLIService.getPRObservationDetails).toHaveBeenCalledTimes(2);
  expect(githubCLIService.getPRReviews).toHaveBeenCalledTimes(2);
  expect(githubCLIService.getReviewComments).toHaveBeenCalledTimes(2);
  expect(githubCLIService.getResolvedReviewCommentIds).toHaveBeenCalledTimes(2);
  // Core facts and conversation comments share one read.
  expect(githubCLIService.getPRStatusDetails).not.toHaveBeenCalled();
});

it('reads conversation comments from the core read for the adversarial-review marker', async () => {
  vi.mocked(githubCLIService.getPRObservationDetails).mockResolvedValue(
    fullDetails({
      comments: [
        {
          id: 'IC_1',
          author: { login: 'me' },
          body: `Review\n${ADVERSARIAL_REVIEW_MARKER}`,
          createdAt: redObservation.observedAt,
          updatedAt: redObservation.observedAt,
          url: `${redObservation.url}#issuecomment-1`,
        },
      ],
    })
  );
  const observation = await prObservationService.fetch(target);
  expect(observation.actionableReviews.map((r) => r.identity)).toEqual(['conversation:IC_1']);
  expect(githubCLIService.getPRObservationDetails).toHaveBeenCalledOnce();
  expect(githubCLIService.getPRStatusDetails).not.toHaveBeenCalled();
});

it('skips the review-thread lookup when the PR has no inline review comments', async () => {
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    reviewsComplete: true,
    resolvedReviewIds: [],
  });
  expect(githubCLIService.getReviewComments).toHaveBeenCalledOnce();
  expect(githubCLIService.getResolvedReviewCommentIds).not.toHaveBeenCalled();
});

it('filters inline comments in resolved threads once any exist', async () => {
  vi.mocked(githubCLIService.getReviewComments).mockResolvedValue([reviewerComment]);
  vi.mocked(githubCLIService.getResolvedReviewCommentIds).mockResolvedValue(new Set([2]));
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    reviewsComplete: true,
    actionableReviews: [],
    resolvedReviewIds: ['comment:2'],
  });
});

it('fetches the explicit association and rejects missing head metadata', async () => {
  mockCore(fullDetails({ headRefOid: undefined }));
  await expect(prObservationService.fetch(target)).rejects.toThrow('head');
  expect(githubCLIService.getPRObservationDetails).toHaveBeenCalledWith('org/repo', 1, undefined);
});

it.each(['username', 'policy', 'reviews', 'conversation comments', 'comments', 'resolved threads'])(
  'preserves CI/conflict facts and claims no resolutions when %s enrichment fails',
  async (failure) => {
    const unavailable = new Error('optional enrichment unavailable');
    vi.mocked(githubCLIService.getReviewComments).mockResolvedValue([reviewerComment]);
    if (failure === 'username') {
      vi.mocked(githubCLIService.getAuthenticatedUsername).mockRejectedValue(unavailable);
    } else if (failure === 'policy') {
      readPolicy.mockRejectedValue(unavailable);
    } else if (failure === 'reviews') {
      vi.mocked(githubCLIService.getPRReviews).mockRejectedValue(unavailable);
    } else if (failure === 'conversation comments') {
      // The combined read failed; the core facts are read again on their own.
      vi.mocked(githubCLIService.getPRObservationDetails).mockRejectedValue(unavailable);
    } else if (failure === 'comments') {
      vi.mocked(githubCLIService.getReviewComments).mockRejectedValue(unavailable);
    } else {
      vi.mocked(githubCLIService.getResolvedReviewCommentIds).mockRejectedValue(unavailable);
    }
    await expect(prObservationService.fetch(target)).resolves.toMatchObject({
      ciStatus: 'FAILURE',
      checks: [
        {
          identity: 'https://github.com/org/repo/actions/runs/1',
          attempt: null,
          name: 'test',
          workflowName: null,
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/org/repo/actions/runs/1',
          startedAt: null,
          completedAt: null,
        },
      ],
      hasMergeConflict: true,
      reviewsComplete: false,
      actionableReviews: [],
      resolvedReviewIds: [],
    });
  }
);

it('carries resolved comment identities even when review comment pages are incomplete', async () => {
  vi.mocked(githubCLIService.getReviewComments).mockImplementation(
    (_repo, _number, _since, _signal, incomplete) => {
      incomplete?.();
      return Promise.resolve([]);
    }
  );
  vi.mocked(githubCLIService.getResolvedReviewCommentIds).mockResolvedValue(new Set([9]));
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    reviewsComplete: false,
    resolvedReviewIds: ['comment:9'],
  });
});

it('carries the GitHub title into the normalized monitoring observation', async () => {
  mockCore(fullDetails({ title: 'Update title from GitHub' }));
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    title: 'Update title from GitHub',
  });
});

it.each(['core', 'review'])(
  'propagates abort from the %s read with the original reason',
  async (read) => {
    const controller = new AbortController();
    const reason = new Error('observation stopped');
    const abort = () => {
      controller.abort(reason);
      return Promise.reject(reason);
    };
    if (read === 'core') {
      vi.mocked(githubCLIService.getPRObservationDetails).mockImplementation(abort);
    } else {
      vi.mocked(githubCLIService.getPRReviews).mockImplementation(abort);
    }
    await expect(prObservationService.fetch(target, controller.signal)).rejects.toBe(reason);
    expect(githubCLIService.getPRObservationDetails).toHaveBeenCalledWith(
      'org/repo',
      1,
      controller.signal
    );
    // An aborted combined read is not retried as a core-only read.
    expect(githubCLIService.getPRStatusDetails).not.toHaveBeenCalled();
    if (read === 'review') {
      expect(githubCLIService.getPRReviews).toHaveBeenCalledWith('org/repo', 1, controller.signal);
    }
  }
);

it('propagates an AbortError even when no supplied signal has been aborted', async () => {
  const error = new DOMException('aborted', 'AbortError');
  vi.mocked(githubCLIService.getPRReviews).mockRejectedValue(error);
  await expect(prObservationService.fetch(target)).rejects.toBe(error);
});

it('propagates an AbortError of the combined read without a core-only retry', async () => {
  const error = new DOMException('aborted', 'AbortError');
  vi.mocked(githubCLIService.getPRObservationDetails).mockRejectedValue(error);
  await expect(prObservationService.fetch(target)).rejects.toBe(error);
  expect(githubCLIService.getPRStatusDetails).not.toHaveBeenCalled();
});

it('rejects core failures and never fabricates a successful CI observation', async () => {
  const error = new Error('core GitHub fetch failed');
  vi.mocked(githubCLIService.getPRObservationDetails).mockRejectedValue(
    new Error('combined GitHub fetch failed')
  );
  vi.mocked(githubCLIService.getPRStatusDetails).mockRejectedValue(error);
  await expect(prObservationService.fetch(target)).rejects.toBe(error);
  await expect(
    prObservationService.fetch(target, undefined, { includeReviews: false })
  ).rejects.toBe(error);
});

it('propagates a connectivity failure of the combined read without a core-only retry', async () => {
  const error = new GitHubConnectivityError('offline', new Error('offline'));
  vi.mocked(githubCLIService.getPRObservationDetails).mockRejectedValue(error);
  await expect(prObservationService.fetch(target)).rejects.toBe(error);
  expect(githubCLIService.getPRStatusDetails).not.toHaveBeenCalled();
});

it('keeps terminal state and the current head when enrichment is unavailable', async () => {
  readPolicy.mockRejectedValue(new Error('settings offline'));
  mockCore(fullDetails({ state: 'MERGED', headRefOid: 'new-head', statusCheckRollup: null }));
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    prState: 'MERGED',
    headSha: 'new-head',
    ciStatus: 'UNKNOWN',
    reviewsComplete: false,
  });
});

it('keeps a known merge conflict while GitHub is still computing mergeability', async () => {
  // GitHub reports UNKNOWN while it recomputes mergeability after the base or
  // head moves. That is not evidence that a conflicting PR became clean.
  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url, hasMergeConflict: true }),
    readPolicy,
  });
  mockCore(fullDetails({ mergeStateStatus: 'UNKNOWN' }));
  expect(await prObservationService.fetch(target)).toMatchObject({ hasMergeConflict: true });

  mockCore(fullDetails({ mergeStateStatus: 'CLEAN' }));
  expect(await prObservationService.fetch(target)).toMatchObject({ hasMergeConflict: false });

  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url, hasMergeConflict: false }),
    readPolicy,
  });
  mockCore(fullDetails({ mergeStateStatus: 'UNKNOWN' }));
  expect(await prObservationService.fetch(target)).toMatchObject({ hasMergeConflict: false });
});

it.each([
  { state: 'MERGED', isDraft: true, reviewDecision: 'APPROVED', expected: 'MERGED' },
  { state: 'CLOSED', isDraft: true, reviewDecision: 'CHANGES_REQUESTED', expected: 'CLOSED' },
  { state: 'OPEN', isDraft: true, reviewDecision: 'APPROVED', expected: 'DRAFT' },
  { state: 'OPEN', isDraft: true, reviewDecision: 'CHANGES_REQUESTED', expected: 'DRAFT' },
  { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', expected: 'APPROVED' },
  {
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'CHANGES_REQUESTED',
    expected: 'CHANGES_REQUESTED',
  },
  { state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', expected: 'OPEN' },
  { state: 'OPEN', isDraft: false, reviewDecision: null, expected: 'OPEN' },
] as const)(
  'maps $state / draft=$isDraft / review=$reviewDecision to $expected',
  async ({ state, isDraft, reviewDecision, expected }) => {
    vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue(
      fullDetails({ state, isDraft, reviewDecision })
    );
    await expect(
      prObservationService.fetch(target, undefined, { includeReviews: false })
    ).resolves.toMatchObject({ prState: expected, reviewState: reviewDecision });
  }
);
