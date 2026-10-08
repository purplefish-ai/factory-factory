import { expect, it } from 'vitest';
import { WorkspacePullRequestSchema } from './workspace-pr';

it.each([-1, 0, 1.5])('rejects invalid PR number %s', (number) => {
  expect(WorkspacePullRequestSchema.shape.number.safeParse(number).success).toBe(false);
});
it.each([null, 1, 42])('accepts a nullable positive PR number %s', (number) => {
  expect(WorkspacePullRequestSchema.shape.number.safeParse(number).success).toBe(true);
});
