import { expect, it, vi } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { githubCLIService } from './github-cli.service';
import { prObservationService } from './pr-observation.service';

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
