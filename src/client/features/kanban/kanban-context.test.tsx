// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { memo, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubIssueRaw } from '@/client/lib/issue-normalization';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import { createTestEventLog } from '@/test-utils/test-event-log';
import { makeCompleteWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import { KanbanProvider, useKanban, useKanbanActions } from './kanban-context';

interface ArchiveError {
  data?: { code?: string | null; applicationErrorKind?: string | null };
  message?: string;
}

interface WorkspaceListItem {
  id: string;
  name?: string;
  kanbanColumn: 'WORKING' | 'WAITING' | 'DONE' | null;
  githubIssueNumber: number | null;
  linearIssueId: string | null;
}

interface ProjectWorkspaceCache {
  workspaces: WorkspaceListItem[];
  reviewCount: number;
}

interface ArchiveManyResult {
  id: string;
  success: boolean;
  error?: string;
  code?: string;
  applicationErrorKind?: string | null;
}

interface MutationOptions {
  onError?: (error: ArchiveError) => void;
}

let archiveInputs = createTestEventLog<unknown>();

const mocks = vi.hoisted(() => ({
  archiveError: undefined as ArchiveError | undefined,
  archiveResponse: undefined as Promise<unknown> | undefined,
  archiveManyError: undefined as ArchiveError | undefined,
  archiveManyResults: [] as ArchiveManyResult[],
  toastErrorMock: vi.fn(),
  workspaceListCancelMock: vi.fn(),
  workspaceListGetDataMock: vi.fn(),
  workspaceListSetDataMock: vi.fn(),
  workspaceGetInvalidateMock: vi.fn(),
  refetchWorkspacesMock: vi.fn(),
  syncAllPRStatusesMock: vi.fn(),
  workspaceListInvalidateMock: vi.fn(),
  refetchGitHubIssuesMock: vi.fn(),
  refetchLinearIssuesMock: vi.fn(),
  archiveManyInputs: [] as unknown[],
  workspaceListState: undefined as ProjectWorkspaceCache | undefined,
  githubIssues: [] as GitHubIssueRaw[],
  toggleRatchetingMutate: vi.fn(),
  pendingToggleWorkspaceIds: [] as string[],
  renameMutateAsync: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastErrorMock,
  },
}));

vi.mock('@/client/hooks/use-toggle-ratcheting', () => ({
  useToggleRatcheting: () => ({
    mutate: mocks.toggleRatchetingMutate,
    pendingWorkspaceIds: mocks.pendingToggleWorkspaceIds,
  }),
}));

function rejectingMutation(
  getError: (input: unknown) => ArchiveError | undefined,
  getSuccessData: () => unknown = () => undefined,
  recordInput: (input: unknown) => void = () => undefined
) {
  return {
    useMutation: (options: MutationOptions = {}) => ({
      mutateAsync: vi.fn((input: unknown) => {
        recordInput(input);
        const error = getError(input);
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
      unreadMailCounts: { useQuery: () => ({ data: {} }) },
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
        useMutation: () => ({ mutate: mocks.syncAllPRStatusesMock, isPending: false }),
      },
      rename: {
        useMutation: () => ({ mutateAsync: mocks.renameMutateAsync }),
      },
      archive: rejectingMutation(
        () => mocks.archiveError,
        () => mocks.archiveResponse,
        (input) => archiveInputs.record(input)
      ),
      archiveMany: rejectingMutation(
        () => mocks.archiveManyError,
        () => ({ results: mocks.archiveManyResults, total: mocks.archiveManyResults.length }),
        (input) => mocks.archiveManyInputs.push(input)
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

async function expectArchiveManyFailures(
  action: () => Promise<{ failedIds: string[] }>,
  failedIds: string[]
) {
  await expect(action()).resolves.toEqual({ failedIds });
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
  mocks.archiveManyError = undefined;
  archiveInputs = createTestEventLog<unknown>();
  mocks.archiveManyInputs = [];
  mocks.archiveManyResults = [{ id: 'workspace-1', success: true }];
  mocks.refetchWorkspacesMock.mockResolvedValue({ isError: false });
  mocks.workspaceListInvalidateMock.mockResolvedValue(undefined);
  mocks.githubIssues = [];
  mocks.pendingToggleWorkspaceIds = [];
  mocks.workspaceListState = {
    workspaces: [
      {
        id: 'workspace-1',
        name: 'Workspace one',
        kanbanColumn: 'WAITING',
        githubIssueNumber: null,
        linearIssueId: null,
      },
      {
        id: 'workspace-2',
        name: 'Workspace two',
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

describe('KanbanProvider selection mode', () => {
  it('starts off and turns on and off through its commands', () => {
    const kanban = renderProvider();
    expect(kanban.isSelecting).toBe(false);
    flushSync(() => kanban.startSelecting());
    expect(context?.isSelecting).toBe(true);
    flushSync(() => kanban.stopSelecting());
    expect(context?.isSelecting).toBe(false);
  });
});

describe('KanbanProvider PR sync', () => {
  it('forces the explicit Sync action past the automatic refresh throttles', () => {
    const kanban = renderProvider();
    kanban.syncAndRefetch();
    expect(mocks.syncAllPRStatusesMock).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project-1',
      force: true,
    });
  });
});

describe('KanbanProvider per-workspace commands', () => {
  it('exposes every in-flight ratchet toggle so concurrent cards stay pending', () => {
    const kanban = renderProvider();
    // Failures are reported by the shared hook, so the command only starts the mutation.
    kanban.toggleWorkspaceRatcheting('workspace-1', true);
    expect(mocks.toggleRatchetingMutate).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      enabled: true,
    });

    mocks.pendingToggleWorkspaceIds = ['workspace-1', 'workspace-2'];
    rerenderProvider();
    expect(context?.togglingWorkspaceIds).toEqual(['workspace-1', 'workspace-2']);
  });

  it('renames through the shared mutation, which owns the refresh', async () => {
    const kanban = renderProvider();
    mocks.renameMutateAsync.mockResolvedValueOnce(undefined);
    await kanban.renameWorkspace('workspace-1', 'Renamed');
    expect(mocks.renameMutateAsync).toHaveBeenCalledExactlyOnceWith({
      id: 'workspace-1',
      name: 'Renamed',
    });
  });
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

    expect(archiveInputs.events.at(-1)).toEqual({
      id: 'workspace-1',
      removeGitIndexLock: true,
    });
  });

  it('handles a whole multi-archive failure and rolls back the optimistic removals', async () => {
    mocks.archiveManyError = {
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'Archive unavailable',
    };
    const kanban = renderProvider();

    await expectArchiveManyFailures(
      () => kanban.archiveWorkspaces(['workspace-1']),
      ['workspace-1']
    );

    expect(mocks.toastErrorMock).toHaveBeenCalledExactlyOnceWith(
      "Couldn't archive Workspace one. Archive unavailable."
    );
    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
  });

  it('reports one whole-request failure once for several workspaces', async () => {
    mocks.archiveManyError = { message: 'One shared request failure' };
    const kanban = renderProvider();
    await expectArchiveManyFailures(
      () => kanban.archiveWorkspaces(['workspace-1', 'workspace-2']),
      ['workspace-1', 'workspace-2']
    );
    expect(mocks.toastErrorMock).toHaveBeenCalledExactlyOnceWith(
      "Couldn't archive 2 workspaces. One shared request failure."
    );
  });

  it('names each failed workspace in one toast and collects every lock ID', async () => {
    mocks.archiveManyResults = ['workspace-1', 'workspace-2'].map((id) => ({
      id,
      success: false,
      error: `${id} failed`,
    }));
    const kanban = renderProvider();
    await expectArchiveManyFailures(
      () => kanban.archiveWorkspaces(['workspace-1', 'workspace-2']),
      ['workspace-1', 'workspace-2']
    );
    expect(mocks.toastErrorMock).toHaveBeenCalledExactlyOnceWith(
      "Couldn't archive 2 workspaces.",
      expect.objectContaining({ description: expect.anything() })
    );
    const [, toastOptions] = mocks.toastErrorMock.mock.calls[0] ?? [];
    const description = document.createElement('div');
    const descriptionRoot = createRoot(description);
    flushSync(() =>
      descriptionRoot.render((toastOptions as { description: ReactNode }).description)
    );
    expect([...description.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Workspace one: workspace-1 failed.',
      'Workspace two: workspace-2 failed.',
    ]);
    flushSync(() => descriptionRoot.unmount());

    mocks.toastErrorMock.mockClear();
    mocks.archiveManyError = {
      data: { applicationErrorKind: 'GIT_INDEX_LOCKED' },
      message: 'Index locked',
    };
    rerenderProvider();
    await expectArchiveManyFailures(
      () => context!.archiveWorkspaces(['workspace-1', 'workspace-2']),
      ['workspace-1', 'workspace-2']
    );
    rerenderProvider();
    expect(context!.archiveGitLockWorkspaceIds).toEqual(['workspace-1', 'workspace-2']);
    expect(mocks.toastErrorMock).not.toHaveBeenCalled();
  });

  it('archives exactly the requested workspaces', async () => {
    mocks.workspaceListState!.workspaces[1]!.kanbanColumn = 'WAITING';
    const kanban = renderProvider();

    await expectArchiveManyFailures(
      () => kanban.archiveWorkspaces(['workspace-1', 'workspace-1']),
      []
    );
    rerenderProvider();

    expect(mocks.archiveManyInputs).toEqual([{ projectId: 'project-1', ids: ['workspace-1'] }]);
    expectVisibleWorkspaceIds(['workspace-2']);
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

  it('keeps a successful multi-archive removed when cache invalidation fails', async () => {
    mocks.workspaceListInvalidateMock.mockRejectedValueOnce(new Error('Workspace refetch failed'));
    const kanban = renderProvider();

    await expectArchiveManyFailures(() => kanban.archiveWorkspaces(['workspace-1']), []);
    rerenderProvider();

    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-2']);
  });

  it('restores failed items of a multi-archive when post-archive refreshes also fail', async () => {
    mocks.archiveManyResults = [
      {
        id: 'workspace-1',
        success: false,
        error: 'Archive service unavailable',
        code: 'INTERNAL_SERVER_ERROR',
      },
    ];
    mocks.workspaceListInvalidateMock.mockRejectedValueOnce(new Error('Workspace refetch failed'));
    const kanban = renderProvider();

    await expectArchiveManyFailures(
      () => kanban.archiveWorkspaces(['workspace-1']),
      ['workspace-1']
    );
    rerenderProvider();

    expect(mocks.workspaceListState?.workspaces.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
    expect(mocks.toastErrorMock).toHaveBeenCalledWith(
      "Couldn't archive Workspace one. Archive service unavailable."
    );
  });

  it('restores and reports a workspace the server returned no result for', async () => {
    mocks.workspaceListState?.workspaces.push({
      id: 'workspace-3',
      name: 'Workspace three',
      kanbanColumn: 'WAITING',
      githubIssueNumber: null,
      linearIssueId: null,
    });
    const kanban = renderProvider();

    await expectArchiveManyFailures(
      () => kanban.archiveWorkspaces(['workspace-1', 'workspace-3']),
      ['workspace-3']
    );
    rerenderProvider();

    expectVisibleWorkspaceIds(['workspace-2', 'workspace-3']);
    expect(mocks.toastErrorMock).toHaveBeenCalledExactlyOnceWith(
      "Couldn't archive Workspace three. The server returned no result for this workspace."
    );
  });

  it('suppresses issue intake immediately from a complete snapshot-first board row', () => {
    mocks.githubIssues = [
      {
        number: 42,
        title: 'Fix the thing',
        url: 'https://github.com/org/repo/issues/42',
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'octocat' },
      },
    ];
    const row = projectSnapshotToWorkspace(makeCompleteWorkspaceSnapshotEntry());
    mocks.workspaceListState = { workspaces: [row], reviewCount: 0 };
    const context = renderProvider();
    expect(context.workspaces?.map((workspace) => workspace.id)).toEqual(['ws-1']);
    expect(context.issues).toEqual([]);
    expect(mocks.refetchWorkspacesMock).not.toHaveBeenCalled();
  });

  it('keeps an archiving workspace suppressing its issue', () => {
    // A workspace mid-archive derives a null column, so the board filters it out
    // of `workspaces`. Its issue link must still suppress the Todo card, or the
    // issue reappears for as long as the archive takes.
    mocks.githubIssues = [
      {
        number: 42,
        title: 'Fix the thing',
        url: 'https://github.com/example/repo/issues/42',
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
        url: 'https://github.com/example/repo/issues/42',
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
    await archiveInputs.waitForCount(1);
    expect(archiveInputs.events).toHaveLength(1);
    rerenderProvider();
    mocks.archiveResponse = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const second = context!.archiveWorkspace('workspace-1');
    await archiveInputs.waitForCount(2);
    expect(archiveInputs.events).toHaveLength(2);
    finishFirst();
    await first;
    rerenderProvider();
    expect(context!.issues).toEqual([]);
    finishSecond();
    await second;
    rerenderProvider();
    expect(context!.issues?.map((issue) => issue.id)).toHaveLength(1);
  });

  it('offers recovery only for the locked subset of a multi-archive', async () => {
    mocks.archiveManyResults = [
      {
        id: 'workspace-1',
        success: false,
        error: 'Git is locked',
        code: 'CONFLICT',
        applicationErrorKind: 'GIT_INDEX_LOCKED',
      },
    ];
    const kanban = renderProvider();

    await expectArchiveManyFailures(
      () => kanban.archiveWorkspaces(['workspace-1']),
      ['workspace-1']
    );
    rerenderProvider();

    expect(mocks.toastErrorMock).not.toHaveBeenCalled();
    expect(context?.archiveGitLockWorkspaceIds).toEqual(['workspace-1']);
    expect(mocks.archiveManyInputs).toEqual([{ projectId: 'project-1', ids: ['workspace-1'] }]);
  });
});

let commandRenders = 0;
const CommandsOnly = memo(function CommandsOnly() {
  commandRenders += 1;
  useKanbanActions();
  return null;
});

describe('KanbanProvider render stability', () => {
  it('keeps commands stable so command-only consumers skip board state changes', () => {
    commandRenders = 0;
    const children = (
      <>
        <Probe />
        <CommandsOnly />
      </>
    );
    const first = renderProvider(children);
    flushSync(() => first.requestInlineForm());
    flushSync(() => first.openQuickChat('workspace-1'));
    flushSync(() => root?.render(providerElement(children)));
    expect(context?.showInlineForm).toBe(true);
    expect(context?.quickChatWorkspaceId).toBe('workspace-1');
    expect(commandRenders).toBe(1);
  });
});
