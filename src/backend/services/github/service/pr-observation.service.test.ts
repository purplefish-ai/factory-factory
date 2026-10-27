import { beforeEach, expect, it, vi } from 'vitest';
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
  vi.spyOn(githubCLIService, 'getPRReviewDetails').mockResolvedValue(fullDetails());
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
    {
      id: 2,
      author: { login: 'reviewer' },
      body: 'Please fix',
      path: 'src/file.ts',
      line: 2,
      url: redObservation.url,
      createdAt: redObservation.observedAt,
      updatedAt: redObservation.observedAt,
    },
  ]);
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    ciStatus: 'FAILURE',
    reviewsComplete: false,
    actionableReviews: [],
    resolvedReviewIds: [],
  });
  expect(githubCLIService.getPRStatusDetails).toHaveBeenCalledTimes(1);
  expect(githubCLIService.getPRReviewDetails).not.toHaveBeenCalled();
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    reviewsComplete: true,
    actionableReviews: [expect.objectContaining({ identity: 'comment:2', author: 'reviewer' })],
  });
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('fetches the explicit association and rejects missing head metadata', async () => {
  vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue(
    fullDetails({ headRefOid: undefined })
  );
  await expect(prObservationService.fetch(target)).rejects.toThrow('head');
  expect(githubCLIService.getPRStatusDetails).toHaveBeenCalledWith('org/repo', 1, undefined);
});

it.each(['username', 'policy', 'reviews', 'comments', 'resolved threads'])(
  'preserves CI/conflict facts and claims no resolutions when %s enrichment fails',
  async (failure) => {
    const unavailable = new Error('optional enrichment unavailable');
    if (failure === 'username') {
      vi.mocked(githubCLIService.getAuthenticatedUsername).mockRejectedValue(unavailable);
    } else if (failure === 'policy') {
      readPolicy.mockRejectedValue(unavailable);
    } else if (failure === 'reviews') {
      vi.mocked(githubCLIService.getPRReviewDetails).mockRejectedValue(unavailable);
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
  vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue(
    fullDetails({ title: 'Update title from GitHub' })
  );
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
      vi.mocked(githubCLIService.getPRStatusDetails).mockImplementation(abort);
    } else {
      vi.mocked(githubCLIService.getPRReviewDetails).mockImplementation(abort);
    }
    await expect(prObservationService.fetch(target, controller.signal)).rejects.toBe(reason);
    expect(githubCLIService.getPRStatusDetails).toHaveBeenCalledWith(
      'org/repo',
      1,
      controller.signal
    );
  }
);

it('propagates an AbortError even when no supplied signal has been aborted', async () => {
  const error = new DOMException('aborted', 'AbortError');
  vi.mocked(githubCLIService.getPRReviewDetails).mockRejectedValue(error);
  await expect(prObservationService.fetch(target)).rejects.toBe(error);
});

it('rejects core failures and never fabricates a successful CI observation', async () => {
  const error = new Error('core GitHub fetch failed');
  vi.mocked(githubCLIService.getPRStatusDetails).mockRejectedValue(error);
  await expect(prObservationService.fetch(target)).rejects.toBe(error);
});

it('keeps terminal state and the current head when enrichment is unavailable', async () => {
  readPolicy.mockRejectedValue(new Error('settings offline'));
  vi.mocked(githubCLIService.getPRStatusDetails).mockResolvedValue(
    fullDetails({ state: 'MERGED', headRefOid: 'new-head', statusCheckRollup: null })
  );
  await expect(prObservationService.fetch(target)).resolves.toMatchObject({
    prState: 'MERGED',
    headSha: 'new-head',
    ciStatus: 'UNKNOWN',
    reviewsComplete: false,
  });
});
