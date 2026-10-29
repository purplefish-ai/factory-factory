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
    prs: [],
    prSummary: { totalCount: 0, openCount: 0, hasNonterminal: false },
  });
  expect(WorkspaceSnapshotEntrySchema.parse(entry)).toEqual(entry);
});

it('rejects explicit incomplete complete fixture overrides', () => {
  expect(() => createSnapshotEntry({ summaryVersion: 1, worktreePath: undefined })).toThrow();
});
