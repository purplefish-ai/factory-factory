import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useProjectIssues } from '@/client/hooks/use-project-issues';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import type { WorkspaceIssueLink } from '@/client/lib/project-issue-visibility';
import { trpc } from '@/client/lib/trpc';
import {
  removeWorkspaceFromProjectSummaryCache,
  removeWorkspacesFromProjectSummaryCache,
  restoreWorkspacesToListCache,
  restoreWorkspacesToProjectSummaryCache,
} from '@/client/lib/workspace-cache-helpers';
import type { IssueProvider } from '@/shared/core';
import type { WorkspaceWithKanban } from './kanban-card';

interface KanbanContextValue {
  projectId: string;
  projectSlug: string;
  issueProvider: IssueProvider;
  workspaces: WorkspaceWithKanban[] | undefined;
  issues: NormalizedIssue[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => void;
  syncAndRefetch: () => void;
  isSyncing: boolean;
  toggleWorkspaceRatcheting: (workspaceId: string, enabled: boolean) => Promise<void>;
  togglingWorkspaceId: string | null;
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  archiveWorkspace: (workspaceId: string, commitUncommitted: boolean) => Promise<void>;
  bulkArchiveColumn: (kanbanColumn: string, commitUncommitted: boolean) => Promise<void>;
  isBulkArchiving: boolean;
  showInlineForm: boolean;
  setShowInlineForm: (show: boolean) => void;
  quickChatWorkspaceId: string | null;
  openQuickChat: (workspaceId: string) => void;
  closeQuickChat: () => void;
}

const KanbanContext = createContext<KanbanContextValue | null>(null);

export function useKanban() {
  const context = useContext(KanbanContext);
  if (!context) {
    throw new Error('useKanban must be used within a KanbanProvider');
  }
  return context;
}

interface KanbanProviderProps {
  projectId: string;
  projectSlug: string;
  issueProvider: IssueProvider;
  children: ReactNode;
}

export function KanbanProvider({
  projectId,
  projectSlug,
  issueProvider,
  children,
}: KanbanProviderProps) {
  const utils = trpc.useUtils();
  const {
    data: workspaces,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
    refetch: refetchWorkspaces,
  } = trpc.workspace.listWithKanbanState.useQuery(
    { projectId },
    {
      // Kanban workspace state is live-synced via /snapshots (useProjectSnapshotSync).
      // Keep tRPC query as bootstrap/fallback, not a periodic poller.
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    }
  );

  const syncMutation = trpc.workspace.syncAllPRStatuses.useMutation({
    onError: (error) => toast.error(`Failed to sync PR statuses: ${error.message}`),
  });
  const toggleRatchetingMutation = useToggleRatcheting(projectId);
  const renameMutation = trpc.workspace.rename.useMutation({
    onError: (error) => toast.error(`Failed to rename workspace: ${error.message}`),
  });
  const handleArchiveError = (error: {
    data?: { code?: string | null } | null;
    message?: string;
  }) => {
    if (error.data?.code === 'PRECONDITION_FAILED') {
      toast.error('Archiving blocked: enable commit before archiving to proceed.');
    } else {
      toast.error(error.message || 'Failed to archive workspace');
    }
  };

  const archiveMutation = trpc.workspace.archive.useMutation({ onError: handleArchiveError });
  const bulkArchiveMutation = trpc.workspace.bulkArchive.useMutation({
    onError: handleArchiveError,
  });
  const [togglingWorkspaceId, setTogglingWorkspaceId] = useState<string | null>(null);
  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<Set<string>>(new Set());
  const [archivingWorkspaceIssueLinks, setArchivingWorkspaceIssueLinks] = useState<
    Map<string, WorkspaceIssueLink>
  >(new Map());
  const {
    issues,
    isLoading: isLoadingIssues,
    refetch: refetchIssues,
  } = useProjectIssues(projectId, issueProvider, {
    workspaceIssueLinks: workspaces,
    optimisticWorkspaceIssueLinks: archivingWorkspaceIssueLinks,
  });
  const [showInlineForm, setShowInlineForm] = useState(false);
  const [quickChatWorkspaceId, setQuickChatWorkspaceId] = useState<string | null>(null);
  const openQuickChat = useCallback(
    (workspaceId: string) => setQuickChatWorkspaceId(workspaceId),
    []
  );
  const closeQuickChat = useCallback(() => setQuickChatWorkspaceId(null), []);

  const syncAndRefetch = () => {
    syncMutation.mutate({ projectId });
    refetchWorkspaces();
    refetchIssues();
  };

  const toggleWorkspaceRatcheting = async (workspaceId: string, enabled: boolean) => {
    setTogglingWorkspaceId(workspaceId);
    try {
      // Optimistic cache updates and settle-time invalidation live in the
      // shared useToggleRatcheting hook.
      await toggleRatchetingMutation.mutateAsync({ workspaceId, enabled });
    } catch {
      // Error feedback is surfaced by useToggleRatcheting's onError toast;
      // callers fire-and-forget, so don't propagate an unhandled rejection.
    } finally {
      setTogglingWorkspaceId(null);
    }
  };

  const renameWorkspace = async (workspaceId: string, name: string) => {
    await renameMutation.mutateAsync({ id: workspaceId, name });
    await Promise.all([
      refetchWorkspaces(),
      utils.workspace.getProjectSummaryState.invalidate({ projectId }),
      utils.workspace.get.invalidate({ id: workspaceId }),
    ]);
  };

  const archiveWorkspace = async (workspaceId: string, commitUncommitted: boolean) => {
    const workspace = workspaces?.find((item) => item.id === workspaceId);

    await Promise.all([
      utils.workspace.listWithKanbanState.cancel({ projectId }),
      utils.workspace.getProjectSummaryState.cancel({ projectId }),
    ]);

    const previousWorkspaceList = utils.workspace.listWithKanbanState.getData({ projectId });
    const previousProjectSummaryState = utils.workspace.getProjectSummaryState.getData({
      projectId,
    });

    utils.workspace.listWithKanbanState.setData({ projectId }, (old) =>
      old?.filter((item) => item.id !== workspaceId)
    );
    utils.workspace.getProjectSummaryState.setData({ projectId }, (old) =>
      removeWorkspaceFromProjectSummaryCache(old, workspaceId)
    );

    setArchivingWorkspaceIds((prev) => {
      const next = new Set(prev);
      next.add(workspaceId);
      return next;
    });
    setArchivingWorkspaceIssueLinks((prev) => {
      const next = new Map(prev);
      next.set(workspaceId, {
        githubIssueNumber: workspace?.githubIssueNumber ?? null,
        linearIssueId: workspace?.linearIssueId ?? null,
      });
      return next;
    });
    try {
      try {
        await archiveMutation.mutateAsync({ id: workspaceId, commitUncommitted });
      } catch {
        utils.workspace.listWithKanbanState.setData({ projectId }, (old) =>
          restoreWorkspacesToListCache(old, previousWorkspaceList, [workspaceId])
        );
        utils.workspace.getProjectSummaryState.setData({ projectId }, (old) =>
          restoreWorkspacesToProjectSummaryCache(old, previousProjectSummaryState, [workspaceId])
        );
        // Error feedback is surfaced by the mutation's onError toast;
        // callers fire-and-forget, so don't propagate an unhandled rejection.
        return;
      }

      await Promise.allSettled([
        refetchWorkspaces(),
        utils.workspace.getProjectSummaryState.invalidate({ projectId }),
        utils.workspace.get.invalidate({ id: workspaceId }),
      ]);
    } finally {
      setArchivingWorkspaceIds((prev) => {
        if (!prev.has(workspaceId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(workspaceId);
        return next;
      });
      setArchivingWorkspaceIssueLinks((prev) => {
        if (!prev.has(workspaceId)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(workspaceId);
        return next;
      });
    }
  };

  const bulkArchiveColumn = async (kanbanColumn: string, commitUncommitted: boolean) => {
    const workspacesToArchive = (workspaces ?? []).filter(
      (workspace) => workspace.kanbanColumn === kanbanColumn
    );
    const workspaceIdsToArchive = workspacesToArchive.map((workspace) => workspace.id);

    await Promise.all([
      utils.workspace.listWithKanbanState.cancel({ projectId }),
      utils.workspace.getProjectSummaryState.cancel({ projectId }),
    ]);

    const previousWorkspaceList = utils.workspace.listWithKanbanState.getData({ projectId });
    const previousProjectSummaryState = utils.workspace.getProjectSummaryState.getData({
      projectId,
    });

    utils.workspace.listWithKanbanState.setData({ projectId }, (old) =>
      old?.filter((workspace) => !workspaceIdsToArchive.includes(workspace.id))
    );
    utils.workspace.getProjectSummaryState.setData({ projectId }, (old) =>
      removeWorkspacesFromProjectSummaryCache(old, workspaceIdsToArchive)
    );

    setArchivingWorkspaceIds((prev) => {
      const next = new Set(prev);
      for (const workspaceId of workspaceIdsToArchive) {
        next.add(workspaceId);
      }
      return next;
    });

    setArchivingWorkspaceIssueLinks((prev) => {
      const next = new Map(prev);
      for (const workspace of workspacesToArchive) {
        next.set(workspace.id, {
          githubIssueNumber: workspace.githubIssueNumber ?? null,
          linearIssueId: workspace.linearIssueId ?? null,
        });
      }
      return next;
    });

    try {
      try {
        const result = await bulkArchiveMutation.mutateAsync({
          projectId,
          kanbanColumn: kanbanColumn as 'WORKING' | 'WAITING' | 'DONE',
          commitUncommitted,
        });
        const failedResults = result.results.filter((item) => !item.success);
        const failedWorkspaceIds = failedResults.map((item) => item.id);
        for (const failedResult of failedResults) {
          handleArchiveError({
            data: { code: failedResult.code },
            message: failedResult.error,
          });
        }
        if (failedWorkspaceIds.length > 0) {
          utils.workspace.listWithKanbanState.setData({ projectId }, (old) =>
            restoreWorkspacesToListCache(old, previousWorkspaceList, failedWorkspaceIds)
          );
          utils.workspace.getProjectSummaryState.setData({ projectId }, (old) =>
            restoreWorkspacesToProjectSummaryCache(
              old,
              previousProjectSummaryState,
              failedWorkspaceIds
            )
          );
        }
      } catch {
        utils.workspace.listWithKanbanState.setData({ projectId }, (old) =>
          restoreWorkspacesToListCache(old, previousWorkspaceList, workspaceIdsToArchive)
        );
        utils.workspace.getProjectSummaryState.setData({ projectId }, (old) =>
          restoreWorkspacesToProjectSummaryCache(
            old,
            previousProjectSummaryState,
            workspaceIdsToArchive
          )
        );
        // Error feedback is surfaced by the mutation's onError toast;
        // callers fire-and-forget, so don't propagate an unhandled rejection.
        return;
      }

      await Promise.allSettled([
        refetchWorkspaces(),
        utils.workspace.getProjectSummaryState.invalidate({ projectId }),
      ]);
    } finally {
      setArchivingWorkspaceIds((prev) => {
        const next = new Set(prev);
        for (const workspaceId of workspaceIdsToArchive) {
          next.delete(workspaceId);
        }
        return next;
      });

      setArchivingWorkspaceIssueLinks((prev) => {
        const next = new Map(prev);
        for (const workspaceId of workspaceIdsToArchive) {
          next.delete(workspaceId);
        }
        return next;
      });
    }
  };

  const refetch = () => {
    refetchWorkspaces();
    refetchIssues();
  };

  const visibleWorkspaces = useMemo(
    () => workspaces?.filter((workspace) => !archivingWorkspaceIds.has(workspace.id)),
    [workspaces, archivingWorkspaceIds]
  );

  return (
    <KanbanContext.Provider
      value={{
        projectId,
        projectSlug,
        issueProvider,
        workspaces: visibleWorkspaces as WorkspaceWithKanban[] | undefined,
        issues,
        isLoading: isLoadingWorkspaces || isLoadingIssues,
        isError: isErrorWorkspaces,
        error: errorWorkspaces ? { message: errorWorkspaces.message } : null,
        refetch,
        syncAndRefetch,
        isSyncing: syncMutation.isPending,
        toggleWorkspaceRatcheting,
        togglingWorkspaceId,
        renameWorkspace,
        archiveWorkspace,
        bulkArchiveColumn,
        isBulkArchiving: bulkArchiveMutation.isPending,
        showInlineForm,
        setShowInlineForm,
        quickChatWorkspaceId,
        openQuickChat,
        closeQuickChat,
      }}
    >
      {children}
    </KanbanContext.Provider>
  );
}
