// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchivedBranchCleanupSection } from './ArchivedBranchCleanupSection';

type Item = { projectId: string; name: string };
type CleanupResult = {
  removed: Array<Item & { pinRef: string }>;
  skipped: Array<Item & { reason: string }>;
  failed: Array<Item & { error: string }>;
};
type MutationOptions = {
  onSuccess: (result: CleanupResult) => void;
  onError: (error: Error) => void;
  onSettled: () => void;
};
type Group = {
  projectId: string;
  projectNames: string[];
  repoPath: string;
  branches: Array<{ name: string; sha: string; safeBecause: 'ON_REMOTE' | 'MERGED_PR' }>;
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const mocks = vi.hoisted(() => ({
  removeMutate: vi.fn(),
  refetch: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
  invalidateRefs: vi.fn(() => Promise.resolve()),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  mutationOptions: null as MutationOptions | null,
  query: {
    data: [] as Group[] | undefined,
    isError: false,
    error: null as Error | null,
  },
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      admin: {
        listArchivedBranchCandidates: { invalidate: mocks.invalidate },
        listArchivedRefCandidates: { invalidate: mocks.invalidateRefs },
      },
    }),
    admin: {
      // The snapshot list has its own tests (ArchivedRefCleanup.test.tsx).
      listArchivedRefCandidates: {
        useQuery: () => ({
          data: [],
          error: null,
          isFetching: false,
          refetch: vi.fn(),
        }),
      },
      removeArchivedRefs: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      listArchivedBranchCandidates: {
        useQuery: () => ({
          ...mocks.query,
          isLoading: false,
          isRefetching: false,
          refetch: mocks.refetch,
        }),
      },
      removeArchivedBranches: {
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
    root?.render(createElement(ArchivedBranchCleanupSection));
  });
  return container;
}

function findButton(name: string) {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === name
  );
}

function confirmDeletion() {
  flushSync(() => {
    findButton('Delete 3 branches')?.click();
  });
  expect(mocks.removeMutate).not.toHaveBeenCalled();
  flushSync(() => {
    findButton('Delete')?.click();
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
      {
        projectId: 'p1',
        projectNames: ['Alpha'],
        repoPath: '/repos/alpha',
        branches: [
          { name: 'me/pushed', sha: SHA_A, safeBecause: 'ON_REMOTE' },
          { name: 'me/squashed', sha: SHA_B, safeBecause: 'MERGED_PR' },
        ],
      },
      {
        projectId: 'p2',
        projectNames: ['Beta', 'Beta (fork)'],
        repoPath: '/repos/beta',
        branches: [{ name: 'me/beta', sha: SHA_C, safeBecause: 'ON_REMOTE' }],
      },
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

describe('ArchivedBranchCleanupSection', () => {
  it('disables deletion when no branch qualifies', () => {
    mocks.query.data = [];
    const container = render();

    expect(container.textContent).toContain('No archived workspace branches to delete.');
    expect(findButton('Delete branches')?.disabled).toBe(true);
  });

  it('shows a scan failure with a retry instead of an empty result', () => {
    mocks.query = { data: undefined, isError: true, error: new Error('not a git repository') };
    const container = render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't scan for archived workspace branches");
    expect(alert?.textContent).toContain('not a git repository');
    expect(container.textContent).not.toContain('No archived workspace branches to delete.');

    flushSync(() => {
      findButton('Retry')?.click();
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('lists candidates per project with counts and why each is safe', () => {
    const container = render();

    expect(container.textContent).toContain('Found 3 branches from archived workspaces.');
    expect(container.textContent).toContain('Alpha (2 branches)');
    expect(container.textContent).toContain('Beta, Beta (fork) (1 branch)');
    expect(container.textContent).toContain('me/pushed (on a remote)');
    expect(container.textContent).toContain('me/squashed (PR merged)');
  });

  it('deletes exactly the listed branches only after confirmation', () => {
    render();
    confirmDeletion();

    expect(mocks.removeMutate).toHaveBeenCalledWith({
      branches: [
        { projectId: 'p1', name: 'me/pushed', sha: SHA_A },
        { projectId: 'p1', name: 'me/squashed', sha: SHA_B },
        { projectId: 'p2', name: 'me/beta', sha: SHA_C },
      ],
    });

    settle((options) =>
      options.onSuccess({
        removed: [
          { projectId: 'p1', name: 'me/pushed', pinRef: 'refs/factory-factory/x' },
          { projectId: 'p1', name: 'me/squashed', pinRef: 'refs/factory-factory/y' },
        ],
        skipped: [{ projectId: 'p2', name: 'me/beta', reason: 'Branch moved since it was listed' }],
        failed: [],
      })
    );

    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Deleted 2 branches. Skipped 1 that changed or no longer qualify.'
    );
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    // Each deleted branch leaves a pin that the snapshot list shows.
    expect(mocks.invalidateRefs).toHaveBeenCalledTimes(1);
    expect(findButton('Delete')).toBeUndefined();
  });

  it('shows the branch and snapshot lists in one section', () => {
    const container = render();

    expect(container.textContent).toContain('Branch and snapshot cleanup');
    expect(container.textContent).toContain('Branches');
    expect(container.textContent).toContain('Archive snapshots');
    expect(container.textContent).toContain('No archive snapshots to delete.');
  });

  it('reports failures from the cleanup result', () => {
    render();
    confirmDeletion();

    settle((options) =>
      options.onSuccess({
        removed: [{ projectId: 'p1', name: 'me/pushed', pinRef: 'refs/factory-factory/x' }],
        skipped: [],
        failed: [{ projectId: 'p1', name: 'me/squashed', error: 'cannot lock ref' }],
      })
    );

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't delete all branches. Deleted 1; failed to delete 1. cannot lock ref"
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('reports a rejected cleanup request', () => {
    render();
    confirmDeletion();

    settle((options) => options.onError(new Error('A branch cleanup is already running')));

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't delete branches. A branch cleanup is already running"
    );
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
