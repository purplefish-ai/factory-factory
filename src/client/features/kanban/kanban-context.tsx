import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useWorkspaceUnreadCounts } from '@/client/features/inbox';
import {
  useWorkspaceArchiveCommand,
  type WorkspaceArchiveOutcome,
} from '@/client/features/workspace';
import { type ProjectIssuesStatus, useProjectIssues } from '@/client/hooks/use-project-issues';
import { useProjectWorkspaceQuery } from '@/client/hooks/use-project-workspace-query';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import { runInBackground } from '@/client/lib/background-task';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import type { WorkspaceIssueLink } from '@/client/lib/project-issue-visibility';
import { trpc } from '@/client/lib/trpc';
import { isArchiveGitIndexLockedError } from '@/client/lib/workspace-archive';
import type { IssueProvider } from '@/shared/core';
import type { WorkspaceWithKanban } from './kanban-card';

interface KanbanContextValue {
  projectId: string;
  projectSlug: string;
  unreadMailCounts?: Record<string, number>;
  issueProvider: IssueProvider;
  workspaces: WorkspaceWithKanban[] | undefined;
  issues: NormalizedIssue[] | undefined;
  issuesStatus: ProjectIssuesStatus;
  issuesError: string | null;
  isFetchingIssues: boolean;
  refetchIssues: () => void;
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
  archiveSelectedWorkspaces: (ids: string[]) => Promise<string[]>;
  bulkArchiveColumn: (kanbanColumn: string) => Promise<void>;
  archiveGitLockWorkspaceIds: string[];
  dismissArchiveGitLock: () => void;
  retryGitLockedArchives: (removeGitIndexLock: boolean) => Promise<void>;
  isBulkArchiving: boolean;
  isArchiving: boolean;
  showInlineForm: boolean;
  setShowInlineForm: (show: boolean) => void;
  /** Increments on every explicit "New Workspace" request, even if the form is already open. */
  inlineFormRequest: number;
  /** Opens the new workspace form and asks the board to reveal it (e.g. switch the mobile tab). */
  requestInlineForm: () => void;
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
  const unreadMailCounts = useWorkspaceUnreadCounts(projectId);
  const {
    data: projectWorkspaces,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
    refetch: refetchWorkspaces,
  } = useProjectWorkspaceQuery(projectId);

  // The board and the sidebar read one list. A null column means the board
  // excludes the workspace (it is archiving), so that filter is the board's
  // view of the shared data rather than a separate fetch.
  const workspaces = useMemo(
    () => projectWorkspaces?.workspaces.filter((workspace) => workspace.kanbanColumn !== null),
    [projectWorkspaces]
  );

  const syncMutation = trpc.workspace.syncAllPRStatuses.useMutation({
    onError: (error) => toast.error(`Couldn't sync PR statuses. ${error.message}`),
  });
  const toggleRatchetingMutation = useToggleRatcheting(projectId);
  const renameMutation = trpc.workspace.rename.useMutation({
    onError: (error) => toast.error(`Couldn't rename workspace. ${error.message}`),
  });
  const archiveCommand = useWorkspaceArchiveCommand();
  const [togglingWorkspaceId, setTogglingWorkspaceId] = useState<string | null>(null);
  const [archiveGitLockWorkspaceIds, setArchiveGitLockWorkspaceIds] = useState<string[]>([]);
  const [archiveIssueOperations, setArchiveIssueOperations] = useState<
    Map<symbol, Map<string, WorkspaceIssueLink>>
  >(new Map());
  const archivingWorkspaceIssueLinks = useMemo(
    () => new Map([...archiveIssueOperations.values()].flatMap((links) => [...links])),
    [archiveIssueOperations]
  );

  const suppressArchiveIssues = (links: Map<string, WorkspaceIssueLink>) => {
    const operation = Symbol('issue suppression');
    setArchiveIssueOperations((current) => new Map(current).set(operation, links));
    return () =>
      setArchiveIssueOperations((current) => {
        const next = new Map(current);
        next.delete(operation);
        return next;
      });
  };
  const {
    issues,
    isFetching: isFetchingIssues,
    status: issuesStatus,
    error: issuesError,
    refetch: refetchIssues,
  } = useProjectIssues(projectId, issueProvider, {
    // Deliberately the unfiltered list: `workspaces` drops null-column
    // workspaces for the board's benefit, and an archiving workspace still owns
    // its issue until the archive completes.
    workspaceIssueLinks: projectWorkspaces?.workspaces,
    optimisticWorkspaceIssueLinks: archivingWorkspaceIssueLinks,
  });
  const [showInlineForm, setShowInlineForm] = useState(false);
  const [inlineFormRequest, setInlineFormRequest] = useState(0);
  const requestInlineForm = useCallback(() => {
    setShowInlineForm(true);
    setInlineFormRequest((count) => count + 1);
  }, []);
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
        : "Couldn't archive workspace";
    toast.error(message);
  };

  const handleArchiveOutcomes = (outcomes: WorkspaceArchiveOutcome[]) => {
    const idsByError = new Map<unknown, string[]>();
    for (const outcome of outcomes) {
      if (!outcome.success) {
        idsByError.set(outcome.error, [...(idsByError.get(outcome.error) ?? []), outcome.id]);
      }
    }
    for (const [error, ids] of idsByError) {
      handleArchiveError(error, ids);
    }
  };

  const syncAndRefetch = () => {
    // An explicit Sync click bypasses the automatic refresh throttles.
    syncMutation.mutate({ projectId, force: true });
    runInBackground(refetchWorkspaces(), "Couldn't refresh data.");
    runInBackground(refetchIssues(), "Couldn't refresh data.");
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

    const releaseIssueSuppression = suppressArchiveIssues(
      new Map([
        [
          workspaceId,
          {
            githubIssueNumber:
              workspace?.githubIssueNumber ??
              archivingWorkspaceIssueLinks.get(workspaceId)?.githubIssueNumber ??
              null,
            linearIssueId:
              workspace?.linearIssueId ??
              archivingWorkspaceIssueLinks.get(workspaceId)?.linearIssueId ??
              null,
          },
        ],
      ])
    );
    try {
      const outcomes = await archiveCommand.archiveWorkspace({
        projectId,
        id: workspaceId,
        removeGitIndexLock,
      });
      handleArchiveOutcomes(outcomes);
    } finally {
      releaseIssueSuppression();
    }
  };

  const archiveSelectedWorkspaces = async (ids: string[]) => {
    // Reuse single-workspace archive transactions and their lock recovery.
    // Limit concurrency so large selections cannot flood Git/worktree cleanup.
    const failed: string[] = [];
    for (const id of ids) {
      const workspace = workspaces?.find((item) => item.id === id);
      if (!workspace) {
        continue;
      }
      const release = suppressArchiveIssues(new Map([[id, workspace]]));
      try {
        const outcomes = await archiveCommand.archiveWorkspace({ projectId, id });
        handleArchiveOutcomes(outcomes);
        failed.push(...outcomes.filter((item) => !item.success).map((item) => item.id));
      } finally {
        release();
      }
    }
    return failed;
  };

  const bulkArchiveColumn = async (kanbanColumn: string) => {
    const workspacesToArchive = (workspaces ?? []).filter(
      (workspace) => workspace.kanbanColumn === kanbanColumn
    );
    const workspaceIdsToArchive = workspacesToArchive.map((workspace) => workspace.id);

    const releaseIssueSuppression = suppressArchiveIssues(
      new Map(
        workspacesToArchive.map((workspace) => [
          workspace.id,
          {
            githubIssueNumber: workspace.githubIssueNumber ?? null,
            linearIssueId: workspace.linearIssueId ?? null,
          },
        ])
      )
    );

    try {
      const outcomes = await archiveCommand.archiveColumn({
        projectId,
        ids: workspaceIdsToArchive,
        kanbanColumn: kanbanColumn as 'WORKING' | 'WAITING' | 'DONE',
      });
      handleArchiveOutcomes(outcomes);
    } finally {
      releaseIssueSuppression();
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
    runInBackground(refetchWorkspaces(), "Couldn't refresh data.");
    runInBackground(refetchIssues(), "Couldn't refresh data.");
  };

  const visibleWorkspaces = useMemo(
    () => workspaces?.filter((workspace) => !archivingWorkspaceIssueLinks.has(workspace.id)),
    [workspaces, archivingWorkspaceIssueLinks]
  );

  return (
    <KanbanContext.Provider
      value={{
        projectId,
        projectSlug,
        unreadMailCounts: unreadMailCounts.data,
        issueProvider,
        workspaces: visibleWorkspaces,
        issues,
        issuesStatus,
        isFetchingIssues,
        issuesError,
        refetchIssues: () => {
          void refetchIssues();
        },
        isLoading: isLoadingWorkspaces,
        isError: isErrorWorkspaces,
        error: errorWorkspaces ? { message: errorWorkspaces.message } : null,
        refetch,
        syncAndRefetch,
        isSyncing: syncMutation.isPending,
        toggleWorkspaceRatcheting,
        togglingWorkspaceId,
        renameWorkspace,
        archiveWorkspace,
        archiveSelectedWorkspaces,
        bulkArchiveColumn,
        archiveGitLockWorkspaceIds,
        dismissArchiveGitLock,
        retryGitLockedArchives,
        isBulkArchiving: archiveCommand.isBulkArchiving,
        isArchiving:
          archiveIssueOperations.size > 0 ||
          archiveCommand.isArchiving ||
          archiveCommand.isBulkArchiving,
        showInlineForm,
        setShowInlineForm,
        inlineFormRequest,
        requestInlineForm,
        quickChatWorkspaceId,
        openQuickChat,
        closeQuickChat,
      }}
    >
      {children}
      {toggleRatchetingMutation.recipientPicker}
    </KanbanContext.Provider>
  );
}
