// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PRState } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { KanbanPrStates } from './kanban-pr-states';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
const container = document.createElement('div');
let root: ReturnType<typeof createRoot>;
function pr(state: PRState, number = 1): WorkspacePullRequest {
  return {
    id: String(number),
    url: `https://github.com/a/b/pull/${number}`,
    number,
    title: null,
    headRefName: null,
    baseRefName: null,
    state,
    reviewState: null,
    ciStatus: 'UNKNOWN',
    hasMergeConflict: false,
    syncedAt: null,
  };
}
function render(prs: WorkspacePullRequest[]) {
  root = createRoot(container);
  act(() =>
    root.render(
      <TooltipProvider>
        <KanbanPrStates prs={prs} />
      </TooltipProvider>
    )
  );
}
afterEach(() => act(() => root.unmount()));
it.each([
  ['OPEN', 'Open'],
  ['DRAFT', 'Draft'],
  ['APPROVED', 'Approved'],
  ['CHANGES_REQUESTED', 'Changes requested'],
  ['MERGED', 'Merged'],
  ['CLOSED', 'Closed'],
  ['NONE', 'Syncing'],
] as const)('shows an accessible %s icon without a second text badge', (state, label) => {
  render([pr(state)]);
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(`#1: ${label}`);
  expect(container.querySelector('svg')).not.toBeNull();
  expect(container.textContent).not.toContain(label);
});
it('shows every attached PR state, grouping matching states with a count', () => {
  render([pr('OPEN', 1), pr('MERGED', 2), pr('OPEN', 3), pr('DRAFT', 4)]);
  const icons = [...container.querySelectorAll('button')];
  expect(icons.map((i) => i.getAttribute('aria-label'))).toEqual([
    '#1, #3: Open',
    '#2: Merged',
    '#4: Draft',
  ]);
  expect(icons[0]?.textContent).toBe('2');
});
it('shows no state when no PRs are attached', () => {
  render([]);
  expect(container.querySelector('button')).toBeNull();
});
