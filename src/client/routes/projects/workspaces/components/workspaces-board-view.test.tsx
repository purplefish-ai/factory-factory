// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useKanban } from '@/client/features/kanban/kanban-context';
import { WorkspacesBoardView } from './workspaces-board-view';

type Workspace = { id: string; kanbanColumn: 'WAITING' | 'WORKING'; createdAt: string };
type WorkspaceList = { workspaces: Workspace[]; reviewCount: number };

const mocks = vi.hoisted(() => ({
  lists: new Map<string, WorkspaceList>(),
  isMobile: false,
  context: null as ReturnType<typeof useKanban> | null,
  rename: vi.fn(),
  archive: vi.fn(),
  bulkArchive: vi.fn(),
  cancel: vi.fn(),
  refetch: vi.fn(),
  invalidate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/client/hooks/use-project-issues', () => ({
  useProjectIssues: () => ({ issues: [], isLoading: false, refetch: vi.fn() }),
}));
vi.mock('@/client/hooks/use-toggle-ratcheting', () => ({
  useToggleRatcheting: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/hooks/use-mobile', () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => mocks.isMobile,
}));
vi.mock('@/client/components/app-header-context', () => ({
  useAppHeader: () => undefined,
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => children,
  HeaderRightSlot: () => null,
}));
vi.mock('@/client/components/project-selector', () => ({
  ProjectSelectorDropdown: () => null,
}));
vi.mock('@/client/features/kanban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/client/features/kanban')>();
  function Probe() {
    mocks.context = actual.useKanban();
    return <div>Project: {mocks.context.projectId}</div>;
  }
  return {
    ...actual,
    KanbanBoard: () => (
      <>
        <Probe />
        <actual.KanbanBoard />
      </>
    ),
    KanbanControls: () => null,
  };
});
vi.mock('@/client/features/kanban/issue-details-sheet', () => ({ IssueDetailsSheet: () => null }));
vi.mock('@/client/features/kanban/kanban-column', () => ({
  getKanbanColumns: () =>
    mocks.isMobile
      ? [
          { id: 'WAITING', label: 'Waiting' },
          { id: 'WORKING', label: 'Working' },
          { id: 'ISSUES', label: 'Issues' },
        ]
      : [{ id: 'WAITING', label: 'Waiting' }],
  KanbanColumn: ({
    column,
    workspaces,
    onBulkArchive,
  }: {
    column: { id: string };
    workspaces: Workspace[];
    onBulkArchive: () => void;
  }) => (
    <div data-column={column.id}>
      {workspaces.map((workspace) => (
        <span key={workspace.id}>{workspace.id}</span>
      ))}
      <button type="button" onClick={onBulkArchive}>
        Archive column
      </button>
    </div>
  ),
}));
vi.mock('@/client/features/kanban/quick-chat-sheet', () => ({
  QuickChatSheet: ({ workspaceId }: { workspaceId: string | null }) =>
    workspaceId ? <div>Quick Chat: {workspaceId}</div> : null,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        listForProject: {
          cancel: mocks.cancel,
          getData: ({ projectId }: { projectId: string }) => mocks.lists.get(projectId),
          setData: (
            { projectId }: { projectId: string },
            update: (old: WorkspaceList | undefined) => WorkspaceList
          ) => {
            mocks.lists.set(projectId, update(mocks.lists.get(projectId)));
          },
        },
        get: { invalidate: mocks.invalidate },
      },
    }),
    workspace: {
      listForProject: {
        useQuery: ({ projectId }: { projectId: string }) => ({
          data: mocks.lists.get(projectId),
          isLoading: !mocks.lists.has(projectId),
          isError: false,
          error: null,
          refetch: () => mocks.refetch(projectId),
        }),
      },
      syncAllPRStatuses: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      rename: { useMutation: () => ({ mutateAsync: mocks.rename }) },
      archive: { useMutation: () => ({ mutateAsync: mocks.archive }) },
      bulkArchive: { useMutation: () => ({ mutateAsync: mocks.bulkArchive, isPending: false }) },
    },
  },
}));

const gitLockError = {
  data: { code: 'CONFLICT', applicationErrorKind: 'GIT_INDEX_LOCKED' },
  message: 'Git is locked',
};

function list(projectId: string): WorkspaceList {
  return {
    workspaces: [1, 2].map((id) => ({
      id: `${projectId}-${id}`,
      kanbanColumn: 'WAITING',
      createdAt: '2026-01-01',
    })),
    reviewCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let actDescriptor: PropertyDescriptor | undefined;

async function render(projectId: string) {
  await act(async () =>
    root.render(
      <WorkspacesBoardView
        projectId={projectId}
        selectedProjectSlug={projectId}
        slug={projectId}
        onProjectChange={vi.fn()}
        onCurrentProjectSelect={vi.fn()}
        projects={[]}
        issueProvider="GITHUB"
      />
    )
  );
}

async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button, `Missing button: ${text}`).toBeDefined();
  await act(async () => button!.click());
}

beforeEach(() => {
  actDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    value: true,
    writable: true,
    configurable: true,
  });
  vi.resetAllMocks();
  mocks.isMobile = false;
  mocks.context = null;
  mocks.lists = new Map(['a', 'b', 'c'].map((id) => [id, list(id)]));
  mocks.archive.mockResolvedValue(undefined);
  mocks.bulkArchive.mockResolvedValue({ results: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  if (actDescriptor) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

describe('WorkspacesBoardView project lifetime', () => {
  it.each(['success', 'failure'] as const)(
    'keeps delayed rename %s owned by its originating project across A/B/A',
    async (outcome) => {
      const request = deferred<void>();
      mocks.rename.mockReturnValueOnce(request.promise);
      await render('a');
      let save!: Promise<void>;
      await act(() => {
        save = mocks.context!.renameWorkspace('a-1', 'Mock rename');
        // Observe rejection before deliberately rejecting the deferred transport.
        void save.catch(() => undefined);
      });
      await render('b');
      await render('a');
      await act(() => mocks.context!.openQuickChat('a-2'));
      const current = mocks.context!;
      await act(async () => {
        if (outcome === 'success') {
          request.resolve();
        } else {
          request.reject(new Error('Mock rename failure'));
        }
        await save.catch(() => undefined);
      });
      expect(mocks.rename).toHaveBeenCalledExactlyOnceWith({ id: 'a-1', name: 'Mock rename' });
      expect(mocks.context).toBe(current);
      expect(current.quickChatWorkspaceId).toBe('a-2');
      expect(current.archiveGitLockWorkspaceIds).toEqual([]);
      if (outcome === 'success') {
        expect(mocks.refetch).toHaveBeenCalledExactlyOnceWith('a');
        expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith({ id: 'a-1' });
      } else {
        expect(mocks.refetch).not.toHaveBeenCalled();
        expect(mocks.invalidate).not.toHaveBeenCalled();
      }
    }
  );

  it('preserves board state when the same project rerenders', async () => {
    await render('a');
    await act(() => {
      mocks.context!.openQuickChat('a-1');
      mocks.context!.setShowInlineForm(true);
    });
    await render('a');
    expect(mocks.context!.quickChatWorkspaceId).toBe('a-1');
    expect(mocks.context!.showInlineForm).toBe(true);
  });

  it('clears recovery, Quick Chat and form state before showing another project', async () => {
    await render('a');
    mocks.archive.mockRejectedValueOnce(gitLockError);
    await act(async () => {
      mocks.context!.openQuickChat('a-1');
      mocks.context!.setShowInlineForm(true);
      await mocks.context!.archiveWorkspace('a-1');
    });
    expect(document.body.textContent).toContain('Git is locked');
    expect(document.body.textContent).toContain('Quick Chat: a-1');
    await render('b');
    expect(mocks.context!.projectId).toBe('b');
    expect(mocks.context!.archiveGitLockWorkspaceIds).toEqual([]);
    expect(mocks.context!.quickChatWorkspaceId).toBeNull();
    expect(mocks.context!.showInlineForm).toBe(false);
    expect(document.body.textContent).not.toContain('Git is locked');
    expect(document.body.textContent).not.toContain('Quick Chat: a-1');
    await act(async () => mocks.context!.retryGitLockedArchives(true));
    expect(mocks.archive).toHaveBeenCalledTimes(1);
  });

  it('drops a pending column confirmation on project switch', async () => {
    await render('a');
    await click('Archive column');
    expect(document.body.textContent).toContain('Archive Workspace');
    await render('b');
    expect(document.body.textContent).not.toContain('Archive Workspace');
    expect(mocks.bulkArchive).not.toHaveBeenCalled();
    await click('Archive column');
    await click('Archive');
    expect(mocks.bulkArchive).toHaveBeenCalledExactlyOnceWith({
      projectId: 'b',
      kanbanColumn: 'WAITING',
    });
  });

  it('starts fresh after rapid A to B to C to A switching', async () => {
    for (const projectId of ['a', 'b', 'c', 'a']) {
      await render(projectId);
      expect(mocks.context!.quickChatWorkspaceId).toBeNull();
      expect(mocks.context!.showInlineForm).toBe(false);
      expect(mocks.context!.workspaces?.map((workspace) => workspace.id)).toEqual([
        `${projectId}-1`,
        `${projectId}-2`,
      ]);
      await act(() => {
        mocks.context!.openQuickChat(`${projectId}-1`);
        mocks.context!.setShowInlineForm(true);
      });
    }
  });

  it('reselects the mobile tab from each project instead of carrying a selected tab over', async () => {
    mocks.isMobile = true;
    await render('a');
    expect(container.querySelector('[data-column]')?.getAttribute('data-column')).toBe('WAITING');
    await click('Working0');
    expect(container.querySelector('[data-column]')?.getAttribute('data-column')).toBe('WORKING');

    await render('b');
    expect(container.querySelector('[data-column]')?.getAttribute('data-column')).toBe('WAITING');
    mocks.lists.set('c', {
      ...list('c'),
      workspaces: list('c').workspaces.map((workspace) => ({
        ...workspace,
        kanbanColumn: 'WORKING',
      })),
    });
    await render('c');
    expect(container.querySelector('[data-column]')?.getAttribute('data-column')).toBe('WORKING');
    mocks.lists.set('a', { workspaces: [], reviewCount: 0 });
    await render('a');
    expect(container.querySelector('[data-column]')).toBeNull();
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Issues0')
        ?.className
    ).toContain('bg-primary');
  });

  it('keeps old Quick Chat closed while the next project bootstrap is delayed', async () => {
    await render('a');
    await act(() => mocks.context!.openQuickChat('a-1'));
    mocks.lists.delete('b');
    await render('b');
    expect(mocks.context!.isLoading).toBe(true);
    expect(mocks.context!.quickChatWorkspaceId).toBeNull();
    expect(mocks.context!.workspaces).toBeUndefined();
    expect(document.body.textContent).not.toContain('a-1');
    mocks.lists.set('b', list('b'));
    await render('b');
    expect(mocks.context!.workspaces?.map((workspace) => workspace.id)).toEqual(['b-1', 'b-2']);
    expect(mocks.context!.quickChatWorkspaceId).toBeNull();
  });

  it('reconciles a delayed successful archive only with its originating project', async () => {
    await render('a');
    const pending = deferred<void>();
    mocks.archive.mockReturnValueOnce(pending.promise);
    let archive!: Promise<void>;
    await act(() => {
      archive = mocks.context!.archiveWorkspace('a-1');
    });
    await render('b');
    await act(async () => {
      pending.resolve();
      await archive;
    });
    expect(mocks.refetch).toHaveBeenCalledExactlyOnceWith('a');
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith({ id: 'a-1' });
    expect(mocks.lists.get('a')?.workspaces.map((workspace) => workspace.id)).toEqual(['a-2']);
    expect(mocks.lists.get('b')).toEqual(list('b'));
    expect(mocks.context!.workspaces?.map((workspace) => workspace.id)).toEqual(['b-1', 'b-2']);
  });

  it.each(['b', 'a'])(
    'isolates a delayed archive failure after switching away and ending on %s',
    async (destination) => {
      await render('a');
      const pending = deferred<void>();
      mocks.archive.mockReturnValueOnce(pending.promise);
      let archive!: Promise<void>;
      await act(() => {
        archive = mocks.context!.archiveWorkspace('a-1');
      });
      expect(mocks.archive).toHaveBeenCalledWith({ id: 'a-1' });
      await render('b');
      if (destination === 'a') {
        await render('a');
      }
      await act(async () => {
        pending.reject(gitLockError);
        await archive;
      });
      await render(destination);
      expect(mocks.context!.archiveGitLockWorkspaceIds).toEqual([]);
      expect(document.body.textContent).not.toContain('Git is locked');
      expect(mocks.lists.get('a')?.workspaces.map((workspace) => workspace.id)).toEqual([
        'a-1',
        'a-2',
      ]);
      expect(mocks.lists.get('b')).toEqual(list('b'));
      await act(async () => mocks.context!.retryGitLockedArchives(true));
      expect(mocks.archive).toHaveBeenCalledTimes(1);
    }
  );

  it('isolates delayed bulk recovery and keeps current-project archive identity', async () => {
    await render('a');
    const pending = deferred<{
      results: Array<{ id: string; success: boolean; code: string; applicationErrorKind: string }>;
    }>();
    mocks.bulkArchive.mockReturnValueOnce(pending.promise);
    let archive!: Promise<void>;
    await act(() => {
      archive = mocks.context!.bulkArchiveColumn('WAITING');
    });
    expect(mocks.bulkArchive).toHaveBeenCalledWith({ projectId: 'a', kanbanColumn: 'WAITING' });
    await render('b');
    await act(async () => {
      pending.resolve({
        results: [
          { id: 'a-1', success: false, code: 'CONFLICT', applicationErrorKind: 'GIT_INDEX_LOCKED' },
        ],
      });
      await archive;
    });
    expect(mocks.context!.archiveGitLockWorkspaceIds).toEqual([]);
    expect(mocks.refetch).toHaveBeenCalledWith('a');
    expect(mocks.lists.get('b')).toEqual(list('b'));

    mocks.archive.mockRejectedValueOnce(gitLockError);
    await act(async () => mocks.context!.archiveWorkspace('b-1'));
    expect(mocks.context!.archiveGitLockWorkspaceIds).toEqual(['b-1']);
    await click('Remove Lock and Archive');
    expect(mocks.archive.mock.calls.map(([input]) => input)).toEqual([
      { id: 'b-1' },
      { id: 'b-1', removeGitIndexLock: true },
    ]);
    expect(mocks.lists.get('a')?.workspaces.map((workspace) => workspace.id)).toEqual(['a-1']);
    expect(mocks.lists.get('b')?.workspaces.map((workspace) => workspace.id)).toEqual(['b-2']);
  });
});
