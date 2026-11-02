import { expect, it } from 'vitest';
import type { WorkspacePullRequest } from './workspace-pr';
import { deriveWorkspacePRSelection } from './workspace-pr';

const pr = (id: string, state: WorkspacePullRequest['state']): WorkspacePullRequest => ({
  id,
  state,
  url: `https://github.com/o/r/pull/${id}`,
  number: 1,
  title: null,
  headRefName: null,
  baseRefName: null,
  reviewState: null,
  ciStatus: 'UNKNOWN',
  hasMergeConflict: false,
  syncedAt: null,
});

it('selects the first nonterminal association in ID order, including unsynced NONE', () => {
  const a = pr('a', 'MERGED'),
    b = pr('b', 'NONE'),
    c = pr('c', 'OPEN');
  const prs = [c, a, b];
  expect(deriveWorkspacePRSelection(prs)).toEqual({ selectedPrId: 'b', selectedPr: b });
  expect(prs).toEqual([c, a, b]);
  expect(deriveWorkspacePRSelection([pr('c', 'CLOSED'), a])).toEqual({
    selectedPrId: 'a',
    selectedPr: a,
  });
  expect(deriveWorkspacePRSelection([])).toEqual({ selectedPrId: null, selectedPr: null });
});
