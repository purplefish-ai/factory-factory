import { describe, expect, it } from 'vitest';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { makeCompleteWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';

const passingPR: WorkspacePullRequest = {
  id: 'passing',
  url: 'https://github.com/org/repo/pull/1',
  number: 1,
  title: 'Passing PR',
  headRefName: 'passing',
  baseRefName: 'main',
  state: 'OPEN',
  reviewState: 'APPROVED',
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
};
const failingPR: WorkspacePullRequest = {
  ...passingPR,
  id: 'failing',
  url: 'https://github.com/org/repo/pull/2',
  number: 2,
  ciStatus: 'FAILURE',
  hasMergeConflict: true,
};

describe('complete workspace snapshot fixture', () => {
  it.each([true, false])('summarizes effective mixed PRs with ratcheting %s', (ratchetEnabled) => {
    const entry = makeCompleteWorkspaceSnapshotEntry({
      prs: [passingPR, failingPR],
      ratchetEnabled,
    });
    expect(entry.prSummary).toEqual({
      totalCount: 2,
      openCount: 2,
      hasNonterminal: true,
      state: 'OPEN',
      ciStatus: 'FAILURE',
      hasMergeConflict: true,
      ratchetState: ratchetEnabled ? 'CI_FAILED' : 'IDLE',
    });
  });

  it('reflects a completed PR collection in the default summary', () => {
    const entry = makeCompleteWorkspaceSnapshotEntry({
      prs: [{ ...passingPR, state: 'MERGED' }],
      ratchetEnabled: true,
    });
    expect(entry.prSummary).toEqual({
      totalCount: 1,
      openCount: 0,
      hasNonterminal: false,
      state: 'MERGED',
      ciStatus: 'UNKNOWN',
      hasMergeConflict: false,
      ratchetState: 'MERGED',
    });
  });

  it('retains explicit omitted-summary overrides so malformed complete claims still fail', () => {
    expect(() => makeCompleteWorkspaceSnapshotEntry({ prSummary: undefined })).toThrow();
  });

  it('preserves an explicitly supplied contradictory summary for targeted fixtures', () => {
    const summary = {
      totalCount: 99,
      openCount: 0,
      hasNonterminal: false,
      state: 'NONE' as const,
      ciStatus: 'UNKNOWN' as const,
      hasMergeConflict: false,
      ratchetState: 'IDLE' as const,
    };
    const entry = makeCompleteWorkspaceSnapshotEntry({
      prs: [failingPR],
      ratchetEnabled: true,
      prSummary: summary,
    });
    expect(entry.prSummary).toEqual(summary);
    expect(entry.prs).toHaveLength(1);
  });
});
