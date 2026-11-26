// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchivedRefCleanup, MAX_REFS_PER_REQUEST } from './ArchivedRefCleanup';

type Item = { projectId: string; ref: string };
type CleanupResult = {
  removed: Item[];
  skipped: Array<Item & { reason: string }>;
  failed: Array<Item & { error: string }>;
};
type MutationOptions = {
  onSuccess: (result: CleanupResult) => void;
  onError: (error: Error) => void;
  onSettled: () => void;
};
type Candidate = {
  ref: string;
  sha: string;
  kind: 'ARCHIVE' | 'DELETED_BRANCH';
  tier: 'REDUNDANT' | 'UNIQUE_WORK';
  workspaceId: string | null;
  workspaceName: string | null;
  branchName: string | null;
  unsharedCommits: number;
  datedAt: Date;
};
type Group = { projectId: string; projectNames: string[]; repoPath: string; refs: Candidate[] };

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const OLD = new Date('2026-09-01T12:00:00Z');

const mocks = vi.hoisted(() => ({
  removeMutate: vi.fn(),
  refetch: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  mutationOptions: null as MutationOptions | null,
  query: {
    data: [] as Group[] | undefined,
    error: null as Error | null,
  },
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      admin: { listArchivedRefCandidates: { invalidate: mocks.invalidate } },
    }),
    admin: {
      listArchivedRefCandidates: {
        useQuery: () => ({ ...mocks.query, isFetching: false, refetch: mocks.refetch }),
      },
      removeArchivedRefs: {
        useMutation: (options: MutationOptions) => {
          mocks.mutationOptions = options;
          return { mutate: mocks.removeMutate, isPending: false };
        },
      },
    },
  },
}));

const candidate = (overrides: Partial<Candidate> & Pick<Candidate, 'ref' | 'sha'>): Candidate => ({
  kind: 'ARCHIVE',
  tier: 'REDUNDANT',
  workspaceId: null,
  workspaceName: null,
  branchName: null,
  unsharedCommits: 0,
  datedAt: OLD,
  ...overrides,
});

const REDUNDANT_ARCHIVE = candidate({
  ref: 'refs/factory-factory/archive/ws-1',
  sha: SHA_A,
  workspaceId: 'ws-1',
  workspaceName: 'Fix login',
});
const REDUNDANT_PIN = candidate({
  ref: `refs/factory-factory/deleted-branches/me_2Fold/${SHA_B}`,
  sha: SHA_B,
  kind: 'DELETED_BRANCH',
  branchName: 'me/old',
});
const UNIQUE_ARCHIVE = candidate({
  ref: 'refs/factory-factory/archive/ws-2',
  sha: SHA_C,
  tier: 'UNIQUE_WORK',
  workspaceId: 'ws-2',
  unsharedCommits: 3,
});
const UNIQUE_PIN = candidate({
  ref: `refs/factory-factory/deleted-branches/me_2Fsquashed/${SHA_D}`,
  sha: SHA_D,
  kind: 'DELETED_BRANCH',
  tier: 'UNIQUE_WORK',
  branchName: 'me/squashed',
  unsharedCommits: 1,
});

let root: Root | null = null;

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(createElement(ArchivedRefCleanup));
  });
  return container;
}

function findButton(name: string) {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === name
  );
}

function checkboxFor(label: string) {
  const labelElement = Array.from(document.body.querySelectorAll('label')).find((element) =>
    element.textContent?.includes(label)
  );
  const id = labelElement?.getAttribute('for');
  const box = id ? document.getElementById(id) : null;
  if (!box) {
    throw new Error(`No checkbox labelled ${label}`);
  }
  return box;
}

function click(element: HTMLElement | undefined) {
  flushSync(() => {
    element?.click();
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
        refs: [REDUNDANT_ARCHIVE, REDUNDANT_PIN, UNIQUE_ARCHIVE],
      },
      {
        projectId: 'p2',
        projectNames: ['Beta'],
        repoPath: '/repos/beta',
        refs: [UNIQUE_PIN],
      },
    ],
    error: null,
  };
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
});

describe('ArchivedRefCleanup', () => {
  it('disables deletion when nothing qualifies', () => {
    mocks.query.data = [];
    const container = render();

    expect(container.textContent).toContain('No archive snapshots to delete.');
    expect(findButton('Delete snapshots')?.disabled).toBe(true);
  });

  it('shows a scan failure with a retry instead of an empty result', () => {
    mocks.query = { data: undefined, error: new Error('not a git repository') };
    const container = render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't scan for archive snapshots");
    expect(container.textContent).not.toContain('No archive snapshots to delete.');
    click(findButton('Retry'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('lists both tiers, describing each ref and the work only it holds', () => {
    const container = render();

    expect(container.textContent).toContain(
      'Delete 2 snapshots whose commits are on a branch or remote'
    );
    expect(container.textContent).toContain('Snapshot of Fix login');
    expect(container.textContent).toContain('Deleted branch me/old');
    expect(container.textContent).toContain('2 snapshots holding work found nowhere else');
    expect(container.textContent).toContain('cannot be recovered');
    expect(container.textContent).toContain('Snapshot of deleted workspace ws-2');
    expect(container.textContent).toContain('3 commits found nowhere else');
    expect(container.textContent).toContain('Deleted branch me/squashed');
    expect(container.textContent).toContain('1 commit found nowhere else');
  });

  it('selects only the redundant tier by default', () => {
    render();

    expect(
      checkboxFor('whose commits are on a branch or remote').getAttribute('aria-checked')
    ).toBe('true');
    expect(checkboxFor('Snapshot of deleted workspace ws-2').getAttribute('aria-checked')).toBe(
      'false'
    );
    click(findButton('Delete 2 snapshots'));
    expect(document.body.textContent).not.toContain('hold work found on no branch or remote');
    click(findButton('Delete'));

    expect(mocks.removeMutate).toHaveBeenCalledWith({
      refs: [
        { projectId: 'p1', ref: REDUNDANT_ARCHIVE.ref, sha: SHA_A, tier: 'REDUNDANT' },
        { projectId: 'p1', ref: REDUNDANT_PIN.ref, sha: SHA_B, tier: 'REDUNDANT' },
      ],
    });
  });

  it('deletes chosen unique work only after a warning in the confirmation', () => {
    render();
    click(checkboxFor('whose commits are on a branch or remote'));
    click(checkboxFor('Snapshot of deleted workspace ws-2'));

    click(findButton('Delete 1 snapshot'));
    expect(mocks.removeMutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      '1 of them holds work found on no branch or remote; once Git garbage-collects it, that work cannot be recovered.'
    );
    click(findButton('Delete'));

    expect(mocks.removeMutate).toHaveBeenCalledWith({
      refs: [{ projectId: 'p1', ref: UNIQUE_ARCHIVE.ref, sha: SHA_C, tier: 'UNIQUE_WORK' }],
    });
  });

  it('selects and clears every snapshot holding unique work at once', () => {
    render();
    click(findButton('Select all'));
    expect(findButton('Delete 4 snapshots')).toBeDefined();
    click(findButton('Clear'));
    expect(findButton('Delete 2 snapshots')).toBeDefined();
  });

  /** Confirm deleting the two redundant snapshots, checking the request the dialog sent. */
  function confirmRedundantDeletion() {
    click(findButton('Delete 2 snapshots'));
    expect(mocks.removeMutate).not.toHaveBeenCalled();
    click(findButton('Delete'));
    expect(mocks.removeMutate).toHaveBeenCalledTimes(1);
    expect(mocks.removeMutate).toHaveBeenCalledWith({
      refs: [
        { projectId: 'p1', ref: REDUNDANT_ARCHIVE.ref, sha: SHA_A, tier: 'REDUNDANT' },
        { projectId: 'p1', ref: REDUNDANT_PIN.ref, sha: SHA_B, tier: 'REDUNDANT' },
      ],
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

  it('reports the result and refreshes the list', () => {
    render();
    confirmRedundantDeletion();

    settle((options) =>
      options.onSuccess({
        removed: [{ projectId: 'p1', ref: REDUNDANT_ARCHIVE.ref }],
        skipped: [
          { projectId: 'p1', ref: REDUNDANT_PIN.ref, reason: 'Now holds work found nowhere else' },
        ],
        failed: [],
      })
    );

    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Deleted 1 snapshot. Skipped 1 that changed or no longer qualify.'
    );
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(findButton('Delete')).toBeUndefined();
  });

  it('reports refs that failed to delete', () => {
    render();
    confirmRedundantDeletion();

    settle((options) =>
      options.onSuccess({
        removed: [{ projectId: 'p1', ref: REDUNDANT_PIN.ref }],
        skipped: [],
        failed: [{ projectId: 'p1', ref: REDUNDANT_ARCHIVE.ref, error: 'cannot lock ref' }],
      })
    );

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't delete all snapshots. Deleted 1; failed to delete 1.",
      { description: 'cannot lock ref' }
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected cleanup request', () => {
    render();
    confirmRedundantDeletion();

    settle((options) =>
      options.onError(new Error('A branch or snapshot cleanup is already running'))
    );

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't delete snapshots.", {
      description: 'A branch or snapshot cleanup is already running',
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it('sends at most the server limit per run, keeping snapshots chosen one by one', () => {
    const many = Array.from({ length: MAX_REFS_PER_REQUEST + 5 }, (_, index) =>
      candidate({
        ref: `refs/factory-factory/archive/ws-many-${index}`,
        sha: index.toString(16).padStart(40, '0'),
        workspaceId: `ws-many-${index}`,
        workspaceName: `Many ${index}`,
      })
    );
    mocks.query.data = [
      {
        projectId: 'p1',
        projectNames: ['Alpha'],
        repoPath: '/repos/alpha',
        refs: [...many, UNIQUE_ARCHIVE],
      },
    ];
    const container = render();
    click(checkboxFor('Snapshot of deleted workspace ws-2'));

    expect(container.textContent).toContain('10,006 selected; one run deletes 10,000.');
    click(findButton('Delete 10,000 snapshots'));
    click(findButton('Delete'));

    const [[input]] = mocks.removeMutate.mock.calls as [[{ refs: Array<{ ref: string }> }]];
    expect(input.refs).toHaveLength(MAX_REFS_PER_REQUEST);
    expect(input.refs[0]).toMatchObject({ ref: UNIQUE_ARCHIVE.ref, tier: 'UNIQUE_WORK' });
  });
});
