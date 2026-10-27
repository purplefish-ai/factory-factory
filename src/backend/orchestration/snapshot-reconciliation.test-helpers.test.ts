import { expect, it } from 'vitest';
import { WorkspaceSnapshotEntrySchema } from '@/shared/workspace-snapshot';
import { createSnapshotEntry } from './snapshot-reconciliation.test-helpers';

it('keeps legacy fixture metadata absent without a completeness claim', () => {
  const entry = createSnapshotEntry({ name: 'Legacy workspace', status: 'NEW' });
  expect(entry).toMatchObject({ name: 'Legacy workspace', status: 'NEW' });
  expect(entry).not.toHaveProperty('summaryVersion');
  expect(entry).not.toHaveProperty('worktreePath');
  expect(entry).not.toHaveProperty('autoIteration');
  expect(WorkspaceSnapshotEntrySchema.parse(entry)).toEqual(entry);
});

it('creates a complete fixture with explicit required nullable fields', () => {
  const entry = createSnapshotEntry({ summaryVersion: 1 });
  expect(entry).toMatchObject({
    summaryVersion: 1,
    worktreePath: null,
    initErrorMessage: null,
    githubIssueNumber: null,
    githubIssueUrl: null,
    linearIssueId: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    creationSource: 'MANUAL',
    autoIteration: null,
    prs: [],
    prSummary: { totalCount: 0, openCount: 0, hasNonterminal: false },
  });
  expect(WorkspaceSnapshotEntrySchema.parse(entry)).toEqual(entry);
});

it('creates a canonical compact loop for complete AUTO fixtures with overridden status', () => {
  const entry = createSnapshotEntry({
    summaryVersion: 1,
    mode: 'AUTO_ITERATION',
    autoIterationStatus: 'RUNNING',
  });
  expect(entry.autoIteration).toEqual({
    status: 'RUNNING',
    currentIteration: null,
    maxIterations: null,
    currentMetricSummary: null,
  });
  expect(WorkspaceSnapshotEntrySchema.parse(entry)).toEqual(entry);
});

it('preserves explicit compact loop fixture values including an unlimited iteration cap', () => {
  const entry = createSnapshotEntry({
    summaryVersion: 1,
    mode: 'AUTO_ITERATION',
    autoIterationStatus: 'RUNNING',
    autoIteration: {
      status: 'RUNNING',
      currentIteration: 3,
      maxIterations: 0,
      currentMetricSummary: '3 passing checks',
    },
    worktreePath: '/workspace/auto',
  });
  expect(entry.autoIteration).toEqual({
    status: 'RUNNING',
    currentIteration: 3,
    maxIterations: 0,
    currentMetricSummary: '3 passing checks',
  });
  expect(entry.worktreePath).toBe('/workspace/auto');
});

it('rejects explicit incomplete or inconsistent complete fixture overrides', () => {
  expect(() => createSnapshotEntry({ summaryVersion: 1, worktreePath: undefined })).toThrow();
  expect(() =>
    createSnapshotEntry({ summaryVersion: 1, mode: 'AUTO_ITERATION', autoIteration: null })
  ).toThrow();
});
