import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useProjectIssues } from '@/client/hooks/use-project-issues';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import type { WorkspaceIssueLink } from '@/client/lib/project-issue-visibility';
import { trpc } from '@/client/lib/trpc';
import { isArchiveGitIndexLockedError } from '@/client/lib/workspace-archive';
import {
  removeWorkspaceFromProjectWorkspaceCache,
  removeWorkspacesFromProjectWorkspaceCache,
  restoreWorkspacesToProjectWorkspaceCache,
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
  archiveWorkspace: (workspaceId: string, removeGitIndexLock?: boolean) => Promise<void>;
  bulkArchiveColumn: (kanbanColumn: string) => Promise<void>;
  archiveGitLockWorkspaceIds: string[];
  dismissArchiveGitLock: () => void;
  retryGitLockedArchives: (removeGitIndexLock: boolean) => Promise<void>;
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
    data: projectWorkspaces,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
    refetch: refetchWorkspaces,
  } = trpc.workspace.listForProject.useQuery(
    { projectId },
    {
      // Kanban workspace state is live-synced via /snapshots (useProjectSnapshotSync).
      // Keep tRPC query as bootstrap/fallback, not a periodic poller.
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    }
  );

  // The board and the sidebar read one list. A null column means the board
  // excludes the workspace (it is archiving), so that filter is the board's
  // view of the shared data rather than a separate fetch.
  const workspaces = useMemo(
    () => projectWorkspaces?.workspaces.filter((workspace) => workspace.kanbanColumn !== null),
    [projectWorkspaces]
  );

  const syncMutation = trpc.workspace.syncAllPRStatuses.useMutation({
    onError: (error) => toast.error(`Failed to sync PR statuses: ${error.message}`),
  });
  const toggleRatchetingMutation = useToggleRatcheting(projectId);
  const renameMutation = trpc.workspace.rename.useMutation({
    onError: (error) => toast.error(`Failed to rename workspace: ${error.message}`),
  });
  const archiveMutation = trpc.workspace.archive.useMutation();
  const bulkArchiveMutation = trpc.workspace.bulkArchive.useMutation();
  const [togglingWorkspaceId, setTogglingWorkspaceId] = useState<string | null>(null);
  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<Set<string>>(new Set());
  const [archiveGitLockWorkspaceIds, setArchiveGitLockWorkspaceIds] = useState<string[]>([]);
  const [archivingWorkspaceIssueLinks, setArchivingWorkspaceIssueLinks] = useState<
    Map<string, WorkspaceIssueLink>
  >(new Map());
  const {
    issues,
    isLoading: isLoadingIssues,
    refetch: refetchIssues,
  } = useProjectIssues(projectId, issueProvider, {
    // Deliberately the unfiltered list: `workspaces` drops null-column
    // workspaces for the board's benefit, and an archiving workspace still owns
    // its issue until the archive completes.
    workspaceIssueLinks: projectWorkspaces?.workspaces,
    optimisticWorkspaceIssueLinks: archivingWorkspaceIssueLinks,
  });
  const [showInlineForm, setShowInlineForm] = useState(false);
  const [quickChatWorkspaceId, setQuickChatWorkspaceId] = useState<string | null>(null);
  const openQuickChat = useCallback(
    (workspaceId: string) => setQuickChatWorkspaceId(workspaceId),
    []
  );
  const closeQuickChat = useCallback(() => setQuickChatWorkspaceId(null), []);

  const handleArchiveError = (error: unknown, workspaceIds: string[]) => {
    if (isArchiveGitIndexLockedError(error)) {
      setArchiveGitLockWorkspaceIds((current) => [...new Set([...current, ...workspaceIds])]);
      return;
    }
    const message =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : 'Failed to archive workspace';
    toast.error(message);
  };

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
    await Promise.all([refetchWorkspaces(), utils.workspace.get.invalidate({ id: workspaceId })]);
  };

  const archiveWorkspace = async (workspaceId: string, removeGitIndexLock = false) => {
    const workspace = workspaces?.find((item) => item.id === workspaceId);

    await utils.workspace.listForProject.cancel({ projectId });

    const previousWorkspaces = utils.workspace.listForProject.getData({ projectId });

    utils.workspace.listForProject.setData({ projectId }, (old) =>
      removeWorkspaceFromProjectWorkspaceCache(old, workspaceId)
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
        await archiveMutation.mutateAsync(
          removeGitIndexLock ? { id: workspaceId, removeGitIndexLock: true } : { id: workspaceId }
        );
      } catch (error) {
        utils.workspace.listForProject.setData({ projectId }, (old) =>
          restoreWorkspacesToProjectWorkspaceCache(old, previousWorkspaces, [workspaceId])
        );
        handleArchiveError(error, [workspaceId]);
        return;
      }

      await Promise.allSettled([
        refetchWorkspaces(),
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

  const bulkArchiveColumn = async (kanbanColumn: string) => {
    const workspacesToArchive = (workspaces ?? []).filter(
      (workspace) => workspace.kanbanColumn === kanbanColumn
    );
    const workspaceIdsToArchive = workspacesToArchive.map((workspace) => workspace.id);

    await utils.workspace.listForProject.cancel({ projectId });

    const previousWorkspaces = utils.workspace.listForProject.getData({ projectId });

    utils.workspace.listForProject.setData({ projectId }, (old) =>
      removeWorkspacesFromProjectWorkspaceCache(old, workspaceIdsToArchive)
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
        });
        const failedResults = result.results.filter((item) => !item.success);
        const failedWorkspaceIds = failedResults.map((item) => item.id);
        for (const failedResult of failedResults) {
          handleArchiveError(
            {
              data: {
                code: failedResult.code,
                applicationErrorKind: failedResult.applicationErrorKind,
              },
              message: failedResult.error,
            },
            [failedResult.id]
          );
        }
        if (failedWorkspaceIds.length > 0) {
          utils.workspace.listForProject.setData({ projectId }, (old) =>
            restoreWorkspacesToProjectWorkspaceCache(old, previousWorkspaces, failedWorkspaceIds)
          );
        }
      } catch (error) {
        utils.workspace.listForProject.setData({ projectId }, (old) =>
          restoreWorkspacesToProjectWorkspaceCache(old, previousWorkspaces, workspaceIdsToArchive)
        );
        handleArchiveError(error, workspaceIdsToArchive);
        return;
      }

      // The archive already succeeded, so a failing refresh must not surface as
      // an archive failure.
      await Promise.allSettled([refetchWorkspaces()]);
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

  const dismissArchiveGitLock = () => setArchiveGitLockWorkspaceIds([]);

  const retryGitLockedArchives = async (removeGitIndexLock: boolean) => {
    const workspaceIds = archiveGitLockWorkspaceIds;
    setArchiveGitLockWorkspaceIds([]);
    for (const workspaceId of workspaceIds) {
      await archiveWorkspace(workspaceId, removeGitIndexLock);
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
        archiveGitLockWorkspaceIds,
        dismissArchiveGitLock,
        retryGitLockedArchives,
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
