import { expect, it, vi } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { githubCLIService } from './github-cli.service';
import { prObservationService } from './pr-observation.service';

it('rejects unknown GitHub identity and retries the lookup on the next observation', async () => {
  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url }),
    readPolicy: async () => ({ reviewTriggerMode: 'CHANGES_REQUESTED' }),
  });
  const lookup = vi
    .spyOn(githubCLIService, 'getAuthenticatedUsername')
    .mockResolvedValueOnce(null)
    .mockResolvedValue('me');
  const details = vi.spyOn(githubCLIService, 'getPRFullDetails').mockResolvedValue({
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
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    labels: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefName: 'feature',
    headRefOid: 'sha',
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
  });
  vi.spyOn(githubCLIService, 'getReviewComments').mockResolvedValue([
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
  vi.spyOn(githubCLIService, 'getResolvedReviewCommentIds').mockResolvedValue(new Set());
  await expect(prObservationService.fetch({ workspaceId: 'w', prId: 'p' })).rejects.toThrow(
    'Unable to determine authenticated GitHub identity'
  );
  expect(details).not.toHaveBeenCalled();
  await expect(prObservationService.fetch({ workspaceId: 'w', prId: 'p' })).resolves.toMatchObject({
    reviewsComplete: true,
    actionableReviews: [expect.objectContaining({ identity: 'comment:2', author: 'reviewer' })],
  });
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('fetches the explicit association and rejects missing head metadata', async () => {
  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url }),
    readPolicy: async () => ({ reviewTriggerMode: 'CHANGES_REQUESTED' }),
  });
  vi.spyOn(githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('me');
  vi.spyOn(githubCLIService, 'getReviewComments').mockResolvedValue([]);
  vi.spyOn(githubCLIService, 'getResolvedReviewCommentIds').mockResolvedValue(new Set());
  const fetch = vi.spyOn(githubCLIService, 'getPRFullDetails').mockResolvedValue({
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
    statusCheckRollup: null,
    reviews: [],
    comments: [],
    labels: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefName: 'feature',
    baseRefName: 'main',
    mergeStateStatus: 'UNKNOWN',
  });
  await expect(prObservationService.fetch({ workspaceId: 'w', prId: 'p' })).rejects.toThrow('head');
  expect(fetch).toHaveBeenCalledWith('org/repo', 1, undefined);
});
it('preserves CI and conflicts when the auxiliary resolved-thread lookup fails', async () => {
  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url }),
    readPolicy: async () => ({ reviewTriggerMode: 'CHANGES_REQUESTED' }),
  });
  vi.spyOn(githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('me');
  vi.spyOn(githubCLIService, 'getReviewComments').mockResolvedValue([]);
  vi.spyOn(githubCLIService, 'getResolvedReviewCommentIds').mockRejectedValue(
    new Error('auxiliary unavailable')
  );
  vi.spyOn(githubCLIService, 'getPRFullDetails').mockResolvedValue({
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
  });
  await expect(prObservationService.fetch({ workspaceId: 'w', prId: 'p' })).resolves.toMatchObject({
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
    resolvedReviewIds: [],
  });
});
it('carries resolved comment identities even when review comment pages are incomplete', async () => {
  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url }),
    readPolicy: async () => ({ reviewTriggerMode: 'CHANGES_REQUESTED' }),
  });
  vi.spyOn(githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('me');

  vi.spyOn(githubCLIService, 'getPRFullDetails').mockResolvedValue({
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
  });
  vi.spyOn(githubCLIService, 'getReviewComments').mockImplementation(
    (_repo, _number, _since, _signal, incomplete) => {
      incomplete?.();
      return Promise.resolve([]);
    }
  );
  vi.spyOn(githubCLIService, 'getResolvedReviewCommentIds').mockResolvedValue(new Set([9]));
  await expect(prObservationService.fetch({ workspaceId: 'w', prId: 'p' })).resolves.toMatchObject({
    reviewsComplete: false,
    resolvedReviewIds: ['comment:9'],
  });
});

it('carries the GitHub title into the normalized monitoring observation', async () => {
  prObservationService.configure({
    findPR: async () => ({ url: redObservation.url }),
    readPolicy: async () => ({ reviewTriggerMode: 'CHANGES_REQUESTED' }),
  });
  vi.spyOn(githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('me');
  vi.spyOn(githubCLIService, 'getReviewComments').mockResolvedValue([]);
  vi.spyOn(githubCLIService, 'getResolvedReviewCommentIds').mockResolvedValue(new Set());
  vi.spyOn(githubCLIService, 'getPRFullDetails').mockResolvedValue({
    number: 1,
    title: 'Update title from GitHub',
    url: redObservation.url,
    author: { login: 'me' },
    repository: { name: 'repo', nameWithOwner: 'org/repo' },
    createdAt: redObservation.observedAt,
    updatedAt: redObservation.observedAt,
    isDraft: false,
    state: 'OPEN',
    reviewDecision: null,
    statusCheckRollup: null,
    reviews: [],
    comments: [],
    labels: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefName: 'feature',
    headRefOid: 'sha',
    baseRefName: 'main',
    mergeStateStatus: 'UNKNOWN',
  });
  await expect(prObservationService.fetch({ workspaceId: 'w', prId: 'p' })).resolves.toMatchObject({
    title: 'Update title from GitHub',
  });
});
