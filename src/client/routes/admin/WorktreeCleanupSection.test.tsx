// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCleanupSection } from './WorktreeCleanupSection';

const mocks = vi.hoisted(() => ({
  removeMutate: vi.fn(),
  orphans: [] as Array<{ projectId: string; projectName: string; path: string }>,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      admin: { listOrphanedWorktrees: { invalidate: vi.fn(() => Promise.resolve()) } },
    }),
    admin: {
      listOrphanedWorktrees: {
        useQuery: () => ({ data: mocks.orphans, isLoading: false }),
      },
      removeOrphanedWorktrees: {
        useMutation: () => ({ mutate: mocks.removeMutate, isPending: false }),
      },
    },
  },
}));

let root: Root | null = null;

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(createElement(WorktreeCleanupSection));
  });
  return container;
}

function findButton(name: string) {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === name
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orphans = [];
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
});

describe('WorktreeCleanupSection', () => {
  it('disables cleanup when nothing is orphaned', () => {
    const container = render();

    expect(container.textContent).toContain('No orphaned worktrees found.');
    expect(findButton('Remove Orphaned Worktrees')?.disabled).toBe(true);
  });

  it('lists orphans and removes them after confirmation', () => {
    mocks.orphans = [
      { projectId: 'p1', projectName: 'Alpha', path: '/wt/alpha/workspace-1' },
      { projectId: 'p1', projectName: 'Alpha', path: '/wt/alpha/workspace-2' },
    ];
    const container = render();

    expect(container.textContent).toContain('Found 2 orphaned worktrees');
    expect(container.textContent).toContain('/wt/alpha/workspace-2');

    flushSync(() => {
      findButton('Remove Orphaned Worktrees')?.click();
    });
    expect(mocks.removeMutate).not.toHaveBeenCalled();

    flushSync(() => {
      findButton('Remove')?.click();
    });
    expect(mocks.removeMutate).toHaveBeenCalledTimes(1);
  });
});
