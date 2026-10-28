// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubIssueRaw } from '@/client/lib/issue-normalization';
import { trpc } from '@/client/lib/trpc';
import { KanbanProvider, useKanban } from './kanban-context';

interface ArchiveError {
  data?: { code?: string | null; applicationErrorKind?: string | null };
  message?: string;
}

interface WorkspaceListItem {
  id: string;
  kanbanColumn: 'WORKING' | 'WAITING' | null;
  githubIssueNumber: number | null;
  linearIssueId: string | null;
}

interface ProjectWorkspaceCache {
  workspaces: WorkspaceListItem[];
  reviewCount: number;
}

interface BulkArchiveResult {
  id: string;
  success: boolean;
  error?: string;
  code?: string;
  applicationErrorKind?: string | null;
}

interface MutationOptions {
  onError?: (error: ArchiveError) => void;
}

const mocks = vi.hoisted(() => ({
  archiveError: undefined as ArchiveError | undefined,
  archiveResponse: undefined as Promise<unknown> | undefined,
  bulkArchiveError: undefined as ArchiveError | undefined,
  bulkArchiveResults: [] as BulkArchiveResult[],
  toastErrorMock: vi.fn(),
  workspaceListCancelMock: vi.fn(),
  workspaceListGetDataMock: vi.fn(),
  workspaceListSetDataMock: vi.fn(),
  workspaceGetInvalidateMock: vi.fn(),
  refetchWorkspacesMock: vi.fn(),
  workspaceListInvalidateMock: vi.fn(),
  refetchGitHubIssuesMock: vi.fn(),
  refetchLinearIssuesMock: vi.fn(),
  archiveInputs: [] as unknown[],
  bulkArchiveInputs: [] as unknown[],
  workspaceListState: undefined as ProjectWorkspaceCache | undefined,
  githubIssues: [] as GitHubIssueRaw[],
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastErrorMock,
  },
}));

vi.mock('@/client/hooks/use-toggle-ratcheting', () => ({
  useToggleRatcheting: () => ({
    mutateAsync: vi.fn(),
  }),
}));

function rejectingMutation(
  getError: () => ArchiveError | undefined,
  getSuccessData: () => unknown = () => undefined,
  recordInput: (input: unknown) => void = () => undefined
) {
  return {
    useMutation: (options: MutationOptions = {}) => ({
      mutateAsync: vi.fn((input: unknown) => {
        recordInput(input);
        const error = getError();
        if (!error) {
          return Promise.resolve(getSuccessData());
        }
        options.onError?.(error);
        return Promise.reject(error);
      }),
      isPending: false,
    }),
  };
}

vi.mock('@/client/hooks/use-project-workspace-query', () => {
  return {
    useProjectWorkspaceQuery: (projectId: string | undefined) =>
      trpc.workspace.listForProject.useQuery(
        { projectId: projectId ?? '' },
        { enabled: Boolean(projectId), staleTime: Infinity, refetchOnWindowFocus: false }
      ),
  };
});

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      admin: {
        checkCLIHealth: {},
      },
      workspace: {
        listForProject: {
          cancel: mocks.workspaceListCancelMock,
          getData: mocks.workspaceListGetDataMock,
          setData: mocks.workspaceListSetDataMock,
          invalidate: mocks.workspaceListInvalidateMock,
        },
        get: {
          invalidate: mocks.workspaceGetInvalidateMock,
        },
      },
    }),
    github: {
      listIssuesForProject: {
        useQuery: () => ({
          data: { issues: mocks.githubIssues },
          isLoading: false,
          refetch: mocks.refetchGitHubIssuesMock,
        }),
      },
    },
    linear: {
      listIssuesForProject: {
        useQuery: () => ({
          data: { issues: [] },
          isLoading: false,
          refetch: mocks.refetchLinearIssuesMock,
        }),
      },
    },
    workspace: {
      listForProject: {
        _def: () => ({ path: ['workspace', 'listForProject'] }),
        useQuery: () => ({
          data: mocks.workspaceListState,
          isLoading: false,
          isError: false,
          error: null,
          refetch: mocks.refetchWorkspacesMock,
        }),
      },
      syncAllPRStatuses: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      rename: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
      archive: rejectingMutation(
        () => mocks.archiveError,
        () => mocks.archiveResponse,
        (input) => mocks.archiveInputs.push(input)
      ),
      bulkArchive: rejectingMutation(
        () => mocks.bulkArchiveError,
        () => ({ results: mocks.bulkArchiveResults, total: mocks.bulkArchiveResults.length }),
        (input) => mocks.bulkArchiveInputs.push(input)
      ),
    },
  },
}));

let queryClient: QueryClient;
let unsubscribeCache: () => void;
let root: Root | undefined;
let context: ReturnType<typeof useKanban> | undefined;

function Probe() {
  context = useKanban();
  return null;
}

function providerElement(children: ReactNode = <Probe />) {
  return (
    <QueryClientProvider client={queryClient}>
      <KanbanProvider projectId="project-1" projectSlug="project" issueProvider="GITHUB">
        {children}
      </KanbanProvider>
    </QueryClientProvider>
  );
}

function renderProvider(children: ReactNode = <Probe />) {
  queryClient.setQueryData(
    getQueryKey(trpc.workspace.listForProject, { projectId: 'project-1' }, 'query'),
    mocks.workspaceListState
  );
  mocks.workspaceListSetDataMock.mockClear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  flushSync(() => {
    root?.render(providerElement(children));
  });

  if (!context) {
    throw new Error('Kanban context was not captured');
  }

  return context;
}

function rerenderProvider() {
  flushSync(() => root?.render(providerElement()));
}

async function expectArchiveToResolve(action: () => Promise<void>) {
  await expect(action()).resolves.toBeUndefined();
  flushSync(() => undefined);
}

function expectVisibleWorkspaceIds(expectedIds: string[]) {
  expect(context?.workspaces?.map((workspace) => workspace.id)).toEqual(expectedIds);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient();
  unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    const data = event.query.state.data as ProjectWorkspaceCache | undefined;
    if (data && data !== mocks.workspaceListState) {
      mocks.workspaceListSetDataMock({ projectId: 'project-1' }, () => data);
    }
  });
  mocks.archiveError = undefined;
  mocks.archiveResponse = undefined;
  mocks.bulkArchiveError = undefined;
  mocks.archiveInputs = [];
  mocks.bulkArchiveInputs = [];
  mocks.bulkArchiveResults = [{ id: 'workspace-1', success: true }];
  mocks.refetchWorkspacesMock.mockResolvedValue({ isError: false });
  mocks.workspaceListInvalidateMock.mockResolvedValue(undefined);
  mocks.githubIssues = [];
  mocks.workspaceListState = {
    workspaces: [
      {
        id: 'workspace-1',
        kanbanColumn: 'WAITING',
        githubIssueNumber: null,
        linearIssueId: null,
      },
      {
        id: 'workspace-2',
        kanbanColumn: 'WORKING',
        githubIssueNumber: null,
        linearIssueId: null,
      },
    ],
    reviewCount: 0,
  };
  mocks.workspaceListGetDataMock.mockImplementation(() => mocks.workspaceListState);
  mocks.workspaceListSetDataMock.mockImplementation(
    (
      _input: { projectId: string },
      updater: (old: ProjectWorkspaceCache | undefined) => ProjectWorkspaceCache | undefined
    ) => {
      mocks.workspaceListState = updater(mocks.workspaceListState);
    }
  );
});

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  unsubscribeCache();
  queryClient.clear();
  root = undefined;
  context = undefined;
  document.body.innerHTML = '';
});

describe('KanbanProvider archive failure handling', () => {
  it('handles an archive service failure and rolls back the optimistic removal', async () => {
    mocks.archiveError = {
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'Archive service unavailable',
    };
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.archiveWorkspace('workspace-1'));

    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Archive service unavailable');
    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
  });

  it('offers recovery instead of a toast for a Git index-lock conflict', async () => {
    mocks.archiveError = {
      data: { code: 'CONFLICT', applicationErrorKind: 'GIT_INDEX_LOCKED' },
      message: 'Git is locked',
    };
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.archiveWorkspace('workspace-1'));
    rerenderProvider();

    expect(mocks.toastErrorMock).not.toHaveBeenCalled();
    expect(context?.archiveGitLockWorkspaceIds).toEqual(['workspace-1']);

    mocks.archiveError = undefined;
    await expectArchiveToResolve(() => context!.retryGitLockedArchives(true));

    expect(mocks.archiveInputs.at(-1)).toEqual({
      id: 'workspace-1',
      removeGitIndexLock: true,
    });
  });

  it('handles a bulk archive failure and rolls back the optimistic removals', async () => {
    mocks.bulkArchiveError = {
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'Bulk archive unavailable',
    };
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING'));

    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Bulk archive unavailable');
    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
  });

  it('reports one whole-request bulk failure once for a multi-workspace column', async () => {
    mocks.workspaceListState!.workspaces[1]!.kanbanColumn = 'WAITING';
    mocks.bulkArchiveError = { message: 'One shared request failure' };
    const kanban = renderProvider();
    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING'));
    expect(mocks.toastErrorMock).toHaveBeenCalledExactlyOnceWith('One shared request failure');
  });

  it('reports distinct per-result bulk errors separately and collects every shared lock ID', async () => {
    mocks.workspaceListState!.workspaces[1]!.kanbanColumn = 'WAITING';
    mocks.bulkArchiveResults = ['workspace-1', 'workspace-2'].map((id) => ({
      id,
      success: false,
      error: 'Distinct result failure',
    }));
    const kanban = renderProvider();
    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING'));
    expect(mocks.toastErrorMock).toHaveBeenCalledTimes(2);
    mocks.toastErrorMock.mockClear();
    mocks.bulkArchiveError = {
      data: { applicationErrorKind: 'GIT_INDEX_LOCKED' },
      message: 'Git locked',
    };
    rerenderProvider();
    await expectArchiveToResolve(() => context!.bulkArchiveColumn('WAITING'));
    rerenderProvider();
    expect(context!.archiveGitLockWorkspaceIds).toEqual(['workspace-1', 'workspace-2']);
    expect(mocks.toastErrorMock).not.toHaveBeenCalled();
  });

  it('keeps a successful single archive removed when list invalidation fails', async () => {
    mocks.workspaceListInvalidateMock.mockRejectedValueOnce(new Error('Workspace refetch failed'));
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.archiveWorkspace('workspace-1'));
    rerenderProvider();

    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-2']);
  });

  it('keeps a successful bulk archive removed when cache invalidation fails', async () => {
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING'));
    rerenderProvider();

    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-2']);
  });

  it('restores bulk items that fail when post-archive refreshes also fail', async () => {
    mocks.bulkArchiveResults = [
      {
        id: 'workspace-1',
        success: false,
        error: 'Archive service unavailable',
        code: 'INTERNAL_SERVER_ERROR',
      },
    ];
    mocks.workspaceListInvalidateMock.mockRejectedValueOnce(new Error('Workspace refetch failed'));
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING'));
    rerenderProvider();

    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Archive service unavailable');
  });

  it('keeps workspaces omitted from bulk archive results removed', async () => {
    mocks.workspaceListState?.workspaces.push({
      id: 'workspace-3',
      kanbanColumn: 'WAITING',
      githubIssueNumber: null,
      linearIssueId: null,
    });
    mocks.workspaceListInvalidateMock.mockRejectedValueOnce(new Error('Workspace refetch failed'));
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING'));
    rerenderProvider();

    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-2']);
    expect(mocks.toastErrorMock).not.toHaveBeenCalled();
  });

  it('keeps an archiving workspace suppressing its issue', () => {
    // A workspace mid-archive derives a null column, so the board filters it out
    // of `workspaces`. Its issue link must still suppress the Todo card, or the
    // issue reappears for as long as the archive takes.
    mocks.githubIssues = [
      {
        number: 42,
        title: 'Fix the thing',
        body: '',
        url: 'https://github.com/example/repo/issues/42',
        state: 'OPEN',
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'octocat' },
      },
    ];
    mocks.workspaceListState = {
      workspaces: [
        {
          id: 'workspace-archiving',
          kanbanColumn: null,
          githubIssueNumber: 42,
          linearIssueId: null,
        },
      ],
      reviewCount: 0,
    };

    const context = renderProvider();

    expect(context.issues).toEqual([]);
  });

  it('keeps issue intake suppressed until both overlapping archive commands finish', async () => {
    mocks.workspaceListState!.workspaces[0]!.githubIssueNumber = 42;
    mocks.githubIssues = [
      {
        number: 42,
        title: 'Issue',
        body: '',
        url: 'https://github.com/example/repo/issues/42',
        state: 'OPEN',
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'user' },
      },
    ];
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    mocks.archiveResponse = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    renderProvider();
    const first = context!.archiveWorkspace('workspace-1');
    await vi.waitFor(() => expect(mocks.archiveInputs).toHaveLength(1));
    rerenderProvider();
    mocks.archiveResponse = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const second = context!.archiveWorkspace('workspace-1');
    await vi.waitFor(() => expect(mocks.archiveInputs).toHaveLength(2));
    finishFirst();
    await first;
    rerenderProvider();
    expect(context!.issues).toEqual([]);
    finishSecond();
    await second;
    rerenderProvider();
    expect(context!.issues?.map((issue) => issue.id)).toHaveLength(1);
  });

  it('offers recovery only for the locked subset of a bulk archive', async () => {
    mocks.bulkArchiveResults = [
      {
        id: 'workspace-1',
        success: false,
        error: 'Git is locked',
        code: 'CONFLICT',
        applicationErrorKind: 'GIT_INDEX_LOCKED',
      },
    ];
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING'));
    rerenderProvider();

    expect(mocks.toastErrorMock).not.toHaveBeenCalled();
    expect(context?.archiveGitLockWorkspaceIds).toEqual(['workspace-1']);
    expect(mocks.bulkArchiveInputs).toEqual([{ projectId: 'project-1', kanbanColumn: 'WAITING' }]);
  });
});
