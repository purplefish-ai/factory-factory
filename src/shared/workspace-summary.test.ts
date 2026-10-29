import { expect, it } from 'vitest';
import { WorkspaceSummarySchema } from './workspace-summary';

it('has no retired workspace mode or loop fields in the summary contract', () => {
  expect(Object.keys(WorkspaceSummarySchema.shape)).not.toEqual(expect.arrayContaining(['mode']));
  expect(
    Object.keys(WorkspaceSummarySchema.shape).filter((key) => key.startsWith('autoIteration'))
  ).toEqual([]);
});
