// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCleanupSection } from './WorktreeCleanupSection';

type CleanupResult = { removed: string[]; failed: Array<{ path: string; error: string }> };
type MutationOptions = {
  onSuccess: (result: CleanupResult) => void;
  onError: (error: Error) => void;
  onSettled: () => void;
};

const mocks = vi.hoisted(() => ({
  removeMutate: vi.fn(),
  refetch: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  mutationOptions: null as MutationOptions | null,
  query: {
    data: [] as Array<{ projectId: string; projectName: string; path: string }> | undefined,
    isError: false,
    error: null as Error | null,
  },
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      admin: { listOrphanedWorktrees: { invalidate: mocks.invalidate } },
    }),
    admin: {
      listOrphanedWorktrees: {
        useQuery: () => ({
          ...mocks.query,
          isLoading: false,
          isRefetching: false,
          refetch: mocks.refetch,
        }),
      },
      removeOrphanedWorktrees: {
        useMutation: (options: MutationOptions) => {
          mocks.mutationOptions = options;
          return { mutate: mocks.removeMutate, isPending: false };
        },
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

function openConfirmDialog() {
  flushSync(() => {
    findButton('Remove Orphaned Worktrees')?.click();
  });
}

function settle(run: (options: MutationOptions) => void) {
  flushSync(() => {
    if (!mocks.mutationOptions) {
      throw new Error('Mutation options were not captured');
    }
    run(mocks.mutationOptions);
    mocks.mutationOptions.onSettled();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutationOptions = null;
  mocks.query = {
    data: [
      { projectId: 'p1', projectName: 'Alpha', path: '/wt/alpha/workspace-1' },
      { projectId: 'p1', projectName: 'Alpha', path: '/wt/alpha/workspace-2' },
    ],
    isError: false,
    error: null,
  };
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
});

describe('WorktreeCleanupSection', () => {
  it('disables cleanup when nothing is orphaned', () => {
    mocks.query.data = [];
    const container = render();

    expect(container.textContent).toContain('No orphaned worktrees found.');
    expect(findButton('Remove Orphaned Worktrees')?.disabled).toBe(true);
  });

  it('shows a scan failure with a retry instead of an empty result', () => {
    mocks.query = { data: undefined, isError: true, error: new Error('EACCES') };
    const container = render();

    expect(container.textContent).toContain('Could not scan for orphaned worktrees: EACCES');
    expect(container.textContent).not.toContain('No orphaned worktrees found.');
    expect(findButton('Remove Orphaned Worktrees')).toBeUndefined();

    flushSync(() => {
      findButton('Retry')?.click();
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('removes orphans only after confirmation and reports success', () => {
    const container = render();
    expect(container.textContent).toContain('Found 2 orphaned worktrees');
    expect(container.textContent).toContain('/wt/alpha/workspace-2');

    openConfirmDialog();
    expect(mocks.removeMutate).not.toHaveBeenCalled();
    flushSync(() => {
      findButton('Remove')?.click();
    });
    expect(mocks.removeMutate).toHaveBeenCalledTimes(1);

    settle((options) =>
      options.onSuccess({ removed: ['/wt/alpha/workspace-1', '/wt/alpha/workspace-2'], failed: [] })
    );

    expect(mocks.toastSuccess).toHaveBeenCalledWith('Removed 2 orphaned worktrees');
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(findButton('Remove')).toBeUndefined();
  });

  it('reports partial failures from the cleanup result', () => {
    render();
    openConfirmDialog();

    settle((options) =>
      options.onSuccess({
        removed: ['/wt/alpha/workspace-2'],
        failed: [{ path: '/wt/alpha/workspace-1', error: 'locked' }],
      })
    );

    expect(mocks.toastError).toHaveBeenCalledWith('Removed 1; failed to remove 1: locked');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected cleanup request', () => {
    render();
    openConfirmDialog();

    settle((options) => options.onError(new Error('FORBIDDEN')));

    expect(mocks.toastError).toHaveBeenCalledWith('Cleanup failed: FORBIDDEN');
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(findButton('Remove')).toBeUndefined();
  });
});
