// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanProvider, useKanban } from './kanban-context';

interface ArchiveError {
  data?: { code?: string | null };
  message?: string;
}

interface ProjectSummaryState {
  workspaces: Array<{ id: string }>;
  reviewCount: number;
}

interface WorkspaceListItem {
  id: string;
  kanbanColumn: 'WORKING' | 'WAITING';
  githubIssueNumber: null;
  linearIssueId: null;
}

interface BulkArchiveResult {
  id: string;
  success: boolean;
  error?: string;
}

interface MutationOptions {
  onError?: (error: ArchiveError) => void;
}

const mocks = vi.hoisted(() => ({
  archiveError: undefined as ArchiveError | undefined,
  bulkArchiveError: undefined as ArchiveError | undefined,
  bulkArchiveResults: [] as BulkArchiveResult[],
  toastErrorMock: vi.fn(),
  workspaceListCancelMock: vi.fn(),
  workspaceListGetDataMock: vi.fn(),
  workspaceListSetDataMock: vi.fn(),
  projectSummaryCancelMock: vi.fn(),
  projectSummaryGetDataMock: vi.fn(),
  projectSummarySetDataMock: vi.fn(),
  projectSummaryInvalidateMock: vi.fn(),
  workspaceGetInvalidateMock: vi.fn(),
  refetchWorkspacesMock: vi.fn(),
  refetchGitHubIssuesMock: vi.fn(),
  refetchLinearIssuesMock: vi.fn(),
  workspaceListState: [] as WorkspaceListItem[],
  projectSummaryState: undefined as ProjectSummaryState | undefined,
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
  getSuccessData: () => unknown = () => undefined
) {
  return {
    useMutation: (options: MutationOptions = {}) => ({
      mutateAsync: vi.fn(() => {
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

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      admin: {
        checkCLIHealth: {},
      },
      workspace: {
        listWithKanbanState: {
          cancel: mocks.workspaceListCancelMock,
          getData: mocks.workspaceListGetDataMock,
          setData: mocks.workspaceListSetDataMock,
        },
        get: {
          invalidate: mocks.workspaceGetInvalidateMock,
        },
        getProjectSummaryState: {
          cancel: mocks.projectSummaryCancelMock,
          getData: mocks.projectSummaryGetDataMock,
          setData: mocks.projectSummarySetDataMock,
          invalidate: mocks.projectSummaryInvalidateMock,
        },
      },
    }),
    github: {
      listIssuesForProject: {
        useQuery: () => ({
          data: { issues: [] },
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
      listWithKanbanState: {
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
      archive: rejectingMutation(() => mocks.archiveError),
      bulkArchive: rejectingMutation(
        () => mocks.bulkArchiveError,
        () => ({ results: mocks.bulkArchiveResults, total: mocks.bulkArchiveResults.length })
      ),
    },
  },
}));

let root: Root | undefined;
let context: ReturnType<typeof useKanban> | undefined;

function Probe() {
  context = useKanban();
  return null;
}

function providerElement(children: ReactNode = <Probe />) {
  return (
    <KanbanProvider projectId="project-1" projectSlug="project" issueProvider="GITHUB">
      {children}
    </KanbanProvider>
  );
}

function renderProvider(children: ReactNode = <Probe />) {
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
  mocks.archiveError = undefined;
  mocks.bulkArchiveError = undefined;
  mocks.bulkArchiveResults = [{ id: 'workspace-1', success: true }];
  mocks.refetchWorkspacesMock.mockResolvedValue({ isError: false });
  mocks.workspaceListState = [
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
  ];
  mocks.workspaceListGetDataMock.mockImplementation(() => mocks.workspaceListState);
  mocks.workspaceListSetDataMock.mockImplementation(
    (
      _input: { projectId: string },
      updater: (old: WorkspaceListItem[] | undefined) => WorkspaceListItem[] | undefined
    ) => {
      mocks.workspaceListState = updater(mocks.workspaceListState) ?? [];
    }
  );
  mocks.projectSummaryState = {
    workspaces: [{ id: 'workspace-1' }, { id: 'workspace-2' }],
    reviewCount: 0,
  };
  mocks.projectSummaryGetDataMock.mockImplementation(() => mocks.projectSummaryState);
  mocks.projectSummarySetDataMock.mockImplementation(
    (
      _input: { projectId: string },
      updater: (old: ProjectSummaryState | undefined) => ProjectSummaryState | undefined
    ) => {
      mocks.projectSummaryState = updater(mocks.projectSummaryState);
    }
  );
});

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  root = undefined;
  context = undefined;
  document.body.innerHTML = '';
});

describe('KanbanProvider archive failure handling', () => {
  it('handles an archive precondition failure and rolls back the optimistic removal', async () => {
    mocks.archiveError = { data: { code: 'PRECONDITION_FAILED' }, message: 'blocked' };
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.archiveWorkspace('workspace-1', false));

    expect(mocks.toastErrorMock).toHaveBeenCalledWith(
      'Archiving blocked: enable commit before archiving to proceed.'
    );
    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.workspaceListState.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expect(mocks.projectSummarySetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.projectSummaryState?.workspaces).toEqual([
      { id: 'workspace-1' },
      { id: 'workspace-2' },
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
  });

  it('handles an archive service failure and rolls back the optimistic removal', async () => {
    mocks.archiveError = {
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'Archive service unavailable',
    };
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.archiveWorkspace('workspace-1', false));

    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Archive service unavailable');
    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.workspaceListState.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expect(mocks.projectSummarySetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.projectSummaryState?.workspaces).toEqual([
      { id: 'workspace-1' },
      { id: 'workspace-2' },
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
  });

  it('handles a bulk archive failure and rolls back the optimistic removals', async () => {
    mocks.bulkArchiveError = {
      data: { code: 'INTERNAL_SERVER_ERROR' },
      message: 'Bulk archive unavailable',
    };
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING', true));

    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Bulk archive unavailable');
    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.workspaceListState.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expect(mocks.projectSummarySetDataMock).toHaveBeenCalledTimes(2);
    expect(mocks.projectSummaryState?.workspaces).toEqual([
      { id: 'workspace-1' },
      { id: 'workspace-2' },
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
  });

  it('keeps a successful single archive removed when workspace refetch fails', async () => {
    mocks.refetchWorkspacesMock.mockRejectedValueOnce(new Error('Workspace refetch failed'));
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.archiveWorkspace('workspace-1', false));
    rerenderProvider();

    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceListState.map((workspace) => workspace.id)).toEqual(['workspace-2']);
    expect(mocks.projectSummarySetDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.projectSummaryState?.workspaces).toEqual([{ id: 'workspace-2' }]);
    expectVisibleWorkspaceIds(['workspace-2']);
  });

  it('keeps a successful bulk archive removed when cache invalidation fails', async () => {
    mocks.projectSummaryInvalidateMock.mockRejectedValueOnce(new Error('Invalidation failed'));
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING', true));
    rerenderProvider();

    expect(mocks.workspaceListSetDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceListState.map((workspace) => workspace.id)).toEqual(['workspace-2']);
    expect(mocks.projectSummarySetDataMock).toHaveBeenCalledTimes(1);
    expect(mocks.projectSummaryState?.workspaces).toEqual([{ id: 'workspace-2' }]);
    expectVisibleWorkspaceIds(['workspace-2']);
  });

  it('restores bulk items that fail when post-archive refreshes also fail', async () => {
    mocks.bulkArchiveResults = [{ id: 'workspace-1', success: false, error: 'blocked' }];
    mocks.refetchWorkspacesMock.mockRejectedValueOnce(new Error('Workspace refetch failed'));
    mocks.projectSummaryInvalidateMock.mockRejectedValueOnce(new Error('Invalidation failed'));
    const kanban = renderProvider();

    await expectArchiveToResolve(() => kanban.bulkArchiveColumn('WAITING', true));
    rerenderProvider();

    expect(mocks.workspaceListState.map((workspace) => workspace.id)).toEqual([
      'workspace-1',
      'workspace-2',
    ]);
    expect(mocks.projectSummaryState?.workspaces).toEqual([
      { id: 'workspace-1' },
      { id: 'workspace-2' },
    ]);
    expectVisibleWorkspaceIds(['workspace-1', 'workspace-2']);
  });
});
