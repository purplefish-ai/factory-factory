// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '@/client/features/kanban/kanban-board';
import { KanbanProvider, useKanban } from '@/client/features/kanban/kanban-context';
import { WorkspacesBoardView } from './workspaces-board-view';

type Workspace = { id: string; kanbanColumn: 'WAITING'; createdAt: string };
type WorkspaceList = { workspaces: Workspace[]; reviewCount: number };

const mocks = vi.hoisted(() => ({
  lists: new Map<string, WorkspaceList>(),
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
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.mock('@/client/components/app-header-context', () => ({
  useAppHeader: () => undefined,
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => children,
  HeaderRightSlot: () => null,
}));
vi.mock('@/client/components/project-selector', () => ({
  ProjectSelectorDropdown: () => null,
}));
vi.mock('@/client/features/kanban', () => ({
  KanbanProvider,
  KanbanBoard: () => (
    <>
      <Probe />
      <KanbanBoard />
    </>
  ),
  KanbanControls: () => null,
}));
vi.mock('@/client/features/kanban/kanban-column', () => ({
  getKanbanColumns: () => [{ id: 'WAITING', label: 'Waiting' }],
  KanbanColumn: ({
    workspaces,
    onBulkArchive,
  }: {
    workspaces: Workspace[];
    onBulkArchive: () => void;
  }) => (
    <div>
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
      rename: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      archive: { useMutation: () => ({ mutateAsync: mocks.archive }) },
      bulkArchive: { useMutation: () => ({ mutateAsync: mocks.bulkArchive, isPending: false }) },
    },
  },
}));

let context: ReturnType<typeof useKanban>;
function Probe() {
  context = useKanban();
  return <div>Project: {context.projectId}</div>;
}

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
  it('preserves board state when the same project rerenders', async () => {
    await render('a');
    await act(() => {
      context.openQuickChat('a-1');
      context.setShowInlineForm(true);
    });
    await render('a');
    expect(context.quickChatWorkspaceId).toBe('a-1');
    expect(context.showInlineForm).toBe(true);
  });

  it('clears recovery, Quick Chat and form state before showing another project', async () => {
    await render('a');
    mocks.archive.mockRejectedValueOnce(gitLockError);
    await act(async () => {
      context.openQuickChat('a-1');
      context.setShowInlineForm(true);
      await context.archiveWorkspace('a-1');
    });
    expect(document.body.textContent).toContain('Git is locked');
    expect(document.body.textContent).toContain('Quick Chat: a-1');
    await render('b');
    expect(context.projectId).toBe('b');
    expect(context.archiveGitLockWorkspaceIds).toEqual([]);
    expect(context.quickChatWorkspaceId).toBeNull();
    expect(context.showInlineForm).toBe(false);
    expect(document.body.textContent).not.toContain('Git is locked');
    expect(document.body.textContent).not.toContain('Quick Chat: a-1');
    await act(async () => context.retryGitLockedArchives(true));
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
      expect(context.quickChatWorkspaceId).toBeNull();
      expect(context.showInlineForm).toBe(false);
      expect(context.workspaces?.map((workspace) => workspace.id)).toEqual([
        `${projectId}-1`,
        `${projectId}-2`,
      ]);
      await act(() => {
        context.openQuickChat(`${projectId}-1`);
        context.setShowInlineForm(true);
      });
    }
  });

  it('keeps old Quick Chat closed while the next project bootstrap is delayed', async () => {
    await render('a');
    await act(() => context.openQuickChat('a-1'));
    mocks.lists.delete('b');
    await render('b');
    expect(context.isLoading).toBe(true);
    expect(context.quickChatWorkspaceId).toBeNull();
    expect(context.workspaces).toBeUndefined();
    expect(document.body.textContent).not.toContain('a-1');
    mocks.lists.set('b', list('b'));
    await render('b');
    expect(context.workspaces?.map((workspace) => workspace.id)).toEqual(['b-1', 'b-2']);
    expect(context.quickChatWorkspaceId).toBeNull();
  });

  it('reconciles a delayed successful archive only with its originating project', async () => {
    await render('a');
    const pending = deferred<void>();
    mocks.archive.mockReturnValueOnce(pending.promise);
    let archive!: Promise<void>;
    await act(() => {
      archive = context.archiveWorkspace('a-1');
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
    expect(context.workspaces?.map((workspace) => workspace.id)).toEqual(['b-1', 'b-2']);
  });

  it.each(['b', 'a'])(
    'isolates a delayed archive failure after switching away and ending on %s',
    async (destination) => {
      await render('a');
      const pending = deferred<void>();
      mocks.archive.mockReturnValueOnce(pending.promise);
      let archive!: Promise<void>;
      await act(() => {
        archive = context.archiveWorkspace('a-1');
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
      expect(context.archiveGitLockWorkspaceIds).toEqual([]);
      expect(document.body.textContent).not.toContain('Git is locked');
      expect(mocks.lists.get('a')?.workspaces.map((workspace) => workspace.id)).toEqual([
        'a-1',
        'a-2',
      ]);
      expect(mocks.lists.get('b')).toEqual(list('b'));
      await act(async () => context.retryGitLockedArchives(true));
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
      archive = context.bulkArchiveColumn('WAITING');
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
    expect(context.archiveGitLockWorkspaceIds).toEqual([]);
    expect(mocks.refetch).toHaveBeenCalledWith('a');
    expect(mocks.lists.get('b')).toEqual(list('b'));

    mocks.archive.mockRejectedValueOnce(gitLockError);
    await act(async () => context.archiveWorkspace('b-1'));
    expect(context.archiveGitLockWorkspaceIds).toEqual(['b-1']);
    await click('Remove Lock and Archive');
    expect(mocks.archive.mock.calls.map(([input]) => input)).toEqual([
      { id: 'b-1' },
      { id: 'b-1', removeGitIndexLock: true },
    ]);
    expect(mocks.lists.get('a')?.workspaces.map((workspace) => workspace.id)).toEqual(['a-1']);
    expect(mocks.lists.get('b')?.workspaces.map((workspace) => workspace.id)).toEqual(['b-2']);
  });
});
