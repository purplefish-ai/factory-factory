import type { PRObservation } from './pr-monitoring';
export const redObservation: PRObservation = {
  url: 'https://github.com/org/repo/pull/1',
  repository: 'org/repo',
  number: 1,
  headSha: 'head-1',
  headBranch: 'feature',
  baseBranch: 'main',
  observedAt: '2026-10-08T00:00:00.000Z',
  prState: 'OPEN',
  ciStatus: 'FAILURE',
  reviewState: null,
  hasMergeConflict: false,
  reviewsComplete: true,
  actionableReviews: [],
  checks: [
    {
      identity: 'run-1',
      attempt: 1,
      name: 'test',
      workflowName: 'CI',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/org/repo/actions/runs/1',
      startedAt: null,
      completedAt: null,
    },
  ],
};
