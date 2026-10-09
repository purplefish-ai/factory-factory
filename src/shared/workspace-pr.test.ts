import { expect, it } from 'vitest';
import { WorkspacePullRequestSchema } from './workspace-pr';

it.each([-1, 0, 1.5])('rejects invalid PR number %s', (number) => {
  expect(WorkspacePullRequestSchema.shape.number.safeParse(number).success).toBe(false);
});
it.each([null, 1, 42])('accepts a nullable positive PR number %s', (number) => {
  expect(WorkspacePullRequestSchema.shape.number.safeParse(number).success).toBe(true);
});

it('accepts a PR association without legacy fixer state', () => {
  expect(
    WorkspacePullRequestSchema.safeParse({
      id: 'pr-1',
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      title: null,
      headRefName: null,
      baseRefName: null,
      state: 'OPEN',
      reviewState: null,
      ciStatus: 'SUCCESS',
      hasMergeConflict: false,
      syncedAt: null,
    }).success
  ).toBe(true);
});
