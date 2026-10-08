// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';

vi.mock('./use-workspace-pr-actions', () => ({
  useWorkspacePrActions: () => ({ pending: false, add: vi.fn(), remove: vi.fn(), review: vi.fn() }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspacePrMenu } from './workspace-pr-menu';

const makePR = (
  id: string,
  state: WorkspacePullRequest['state'] = 'OPEN'
): WorkspacePullRequest => ({
  id,
  url: `https://github.com/${id}/repo/pull/42`,
  number: 42,
  title: `Title ${id}`,
  headRefName: id,
  baseRefName: 'main',
  state,
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
  ratchet: {
    lastCheckedAt: null,
    dispatchOutcome: null,
    dispatchRetryCount: 0,
    dispatchStalled: false,
  },
});
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = '';
});
async function render(node: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
}
async function key(element: Element, key: string) {
  await act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
}
function item(label: string) {
  const result = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (element) => element.textContent === label
  );
  if (!result) {
    throw new Error(`Missing menu item ${label}`);
  }
  return result;
}
async function open() {
  const trigger = document.querySelector('button')!;
  trigger.focus();
  await key(trigger, 'Enter');
}
describe('WorkspacePrMenu', () => {
  it('shows terminal status without nested interactive controls', async () => {
    await render(<WorkspacePrMenu prs={[makePR('a', 'MERGED')]} />);
    await open();
    const row = document.querySelector('[role="menuitem"]')!;
    expect(row.textContent).toContain('Merged');
    expect(row.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it('exposes one empty-state add action with keyboard navigation', async () => {
    const onAdd = vi.fn();
    await render(<WorkspacePrMenu prs={[]} onAdd={onAdd} />);
    await open();
    expect(document.body.textContent).toContain('No PRs yet');
    const add = item('Add PR');
    await key(add, 'Enter');
    expect(onAdd).toHaveBeenCalledOnce();
  });
  it('uses the PR number for a single attachment', async () => {
    await render(<WorkspacePrMenu prs={[makePR('a')]} />);
    expect(document.querySelector('button')?.textContent).toContain('#42');
  });
  it('targets the chosen PR even when numbers match across repositories', async () => {
    const onReview = vi.fn();
    await render(
      <WorkspacePrMenu prs={[makePR('a'), makePR('b')]} onReview={onReview} onRemove={vi.fn()} />
    );
    await open();
    const row = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) =>
      element.textContent?.includes('Title b')
    )!;
    await key(row, 'ArrowRight');
    await vi.waitFor(() => expect(item('Run review')).toBeTruthy());
    expect(document.querySelector('a')?.href).toBe(makePR('b').url);
    await key(item('Run review'), 'Enter');
    expect(onReview).toHaveBeenCalledWith('b');
  });
  it.each(['MERGED', 'CLOSED', 'NONE'] as const)(
    'disables review for %s without disabling removal',
    async (state) => {
      await render(
        <WorkspacePrMenu
          prs={[makePR('a', state)]}
          onReview={vi.fn()}
          onRemove={vi.fn()}
          pending={false}
        />
      );
      await open();
      const row = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) =>
        element.textContent?.includes('Title a')
      )!;
      await key(row, 'ArrowRight');
      await vi.waitFor(() => expect(item('Run review').getAttribute('aria-disabled')).toBe('true'));
      expect(item('Remove from workspace').getAttribute('aria-disabled')).not.toBe('true');
    }
  );
  it('disables review and removal for an open PR while a mutation is pending', async () => {
    await render(
      <WorkspacePrMenu prs={[makePR('a')]} onReview={vi.fn()} onRemove={vi.fn()} pending />
    );
    await open();
    const row = document.querySelector('[role="menuitem"]')!;
    await key(row, 'ArrowRight');
    await vi.waitFor(() => expect(item('Run review').getAttribute('aria-disabled')).toBe('true'));
    expect(item('Remove from workspace').getAttribute('aria-disabled')).toBe('true');
  });
});
