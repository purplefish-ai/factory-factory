// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import { ArchiveSelectionDialog, summarizeArchiveRisks } from './archive-selection-dialog';
import { baseWorkspace } from './kanban-card.story-fixtures';

const openPr = { ...deriveWorkspacePRSummary([], true), openCount: 1 };

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('summarizeArchiveRisks', () => {
  it('names the workspaces behind each risk the list data shows', () => {
    expect(
      summarizeArchiveRisks([
        { ...baseWorkspace, name: 'Quiet' },
        { ...baseWorkspace, name: 'Busy', isWorking: true, runScriptStatus: 'RUNNING' },
        {
          ...baseWorkspace,
          name: 'Dirty',
          gitStats: { total: 1, additions: 1, deletions: 0, hasUncommitted: true },
        },
        { ...baseWorkspace, name: 'Reviewed', prSummary: openPr, childWorkspaceCount: 2 },
      ])
    ).toEqual([
      { label: 'Agent running', names: ['Busy'] },
      { label: 'Uncommitted changes', names: ['Dirty'] },
      { label: 'Open pull request', names: ['Reviewed'] },
      { label: 'Dev server running', names: ['Busy'] },
      { label: 'Has child workspaces, which stay active', names: ['Reviewed'] },
    ]);
  });

  it('reports nothing for idle, clean workspaces without open PRs', () => {
    expect(summarizeArchiveRisks([baseWorkspace, { ...baseWorkspace, gitStats: null }])).toEqual(
      []
    );
  });
});

describe('ArchiveSelectionDialog', () => {
  it('shows the count, shortens long name lists and confirms then closes', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ArchiveSelectionDialog
          open
          onOpenChange={onOpenChange}
          workspaces={['A', 'B', 'C', 'D', 'E'].map((name) => ({
            ...baseWorkspace,
            name,
            isWorking: true,
          }))}
          scope="This archives every workspace in Done."
          onConfirm={onConfirm}
        />
      )
    );
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Archive 5 workspaces?');
    expect(dialog.textContent).toContain('This archives every workspace in Done. Running agents');
    expect(dialog.textContent).toContain('Agent running (5): A, B, C and 2 more');
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Archive 5'
    )!;
    act(() => confirm.click());
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    act(() => root.unmount());
  });
});
