import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useWorkspaceUnreadCounts } from '@/client/features/inbox';
import {
  useRenameWorkspace,
  useWorkspaceArchiveCommand,
  type WorkspaceArchiveOutcome,
} from '@/client/features/workspace';
import { type ProjectIssuesStatus, useProjectIssues } from '@/client/hooks/use-project-issues';
import { useProjectWorkspaceQuery } from '@/client/hooks/use-project-workspace-query';
import { useStableCallback } from '@/client/hooks/use-stable-callback';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import { runInBackground } from '@/client/lib/background-task';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import type { WorkspaceIssueLink } from '@/client/lib/project-issue-visibility';
import { trpc } from '@/client/lib/trpc';
import { isArchiveGitIndexLockedError } from '@/client/lib/workspace-archive';
import type { IssueProvider } from '@/shared/core';
import type { WorkspaceWithKanban } from './kanban-card';

function archiveErrorMessage(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : null;
}

/**
 * One toast for the failures of a multi-workspace archive, naming each
 * workspace. A request that failed as a whole shares one error, shown once.
 */
function reportArchiveFailures(failures: { id: string; name: string; error: unknown }[]) {
  const [first] = failures;
  if (!first) {
    return;
  }
  if (failures.length === 1) {
    const message = archiveErrorMessage(first.error);
    toast.error(`Couldn't archive ${first.name}.${message ? ` ${message}` : ''}`);
    return;
  }
  const title = `Couldn't archive ${failures.length} workspaces.`;
  if (failures.every((failure) => failure.error === first.error)) {
    const message = archiveErrorMessage(first.error);
    toast.error(message ? `${title} ${message}` : title);
    return;
  }
  toast.error(title, {
    description: (
      <ul className="list-disc pl-4">
        {failures.map((failure) => (
          <li key={failure.id}>
            {failure.name}: {archiveErrorMessage(failure.error) ?? 'Archive failed'}
          </li>
        ))}
      </ul>
    ),
  });
}

/** Board data; a new value only when one of these fields changes. */
interface KanbanState {
  projectId: string;
  projectSlug: string;
  unreadMailCounts?: Record<string, number>;
  issueProvider: IssueProvider;
  workspaces: WorkspaceWithKanban[] | undefined;
  issues: NormalizedIssue[] | undefined;
  issuesStatus: ProjectIssuesStatus;
  issuesError: string | null;
  isFetchingIssues: boolean;
  isLoading: boolean;
  /** The workspace list's error; cached workspaces stay listed beside it. */
  error: { message: string } | null;
  isFetching: boolean;
  isSyncing: boolean;
  /** Workspaces whose PR-updates toggle is in flight; each card shows its own. */
  togglingWorkspaceIds: readonly string[];
  archiveGitLockWorkspaceIds: string[];
  isBulkArchiving: boolean;
  isArchiving: boolean;
  /** Selection mode: cards show checkboxes and a click selects instead of opening. */
  isSelecting: boolean;
  showInlineForm: boolean;
  /** Increments on every explicit "New Workspace" request, even if the form is already open. */
  inlineFormRequest: number;
  quickChatWorkspaceId: string | null;
}

/** Board commands; each keeps its identity for the provider's lifetime. */
interface KanbanActions {
  refetchIssues: () => void;
  refetch: () => void;
  syncAndRefetch: () => void;
  /** Failures are reported by useToggleRatcheting's error toast. */
  toggleWorkspaceRatcheting: (workspaceId: string, enabled: boolean) => void;
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  archiveWorkspace: (workspaceId: string, removeGitIndexLock?: boolean) => Promise<void>;
  /**
   * Archives exactly these workspaces and reports each failure (index-lock
   * failures through the lock dialog). Resolves with the IDs that failed.
   */
  archiveWorkspaces: (ids: readonly string[]) => Promise<{ failedIds: string[] }>;
  startSelecting: () => void;
  stopSelecting: () => void;
  dismissArchiveGitLock: () => void;
  retryGitLockedArchives: (removeGitIndexLock: boolean) => Promise<void>;
  setShowInlineForm: (show: boolean) => void;
  /** Opens the new workspace form and asks the board to reveal it (e.g. switch the mobile tab). */
  requestInlineForm: () => void;
  openQuickChat: (workspaceId: string) => void;
  closeQuickChat: () => void;
}

const KanbanStateContext = createContext<KanbanState | null>(null);
const KanbanActionsContext = createContext<KanbanActions | null>(null);

/** Board data; the consumer re-renders when any of it changes. */
export function useKanbanState(): KanbanState {
  const context = useContext(KanbanStateContext);
  if (!context) {
    throw new Error('useKanbanState must be used within a KanbanProvider');
  }
  return context;
}

/** Board commands. They never change, so they never re-render a consumer. */
export function useKanbanActions(): KanbanActions {
  const context = useContext(KanbanActionsContext);
  if (!context) {
    throw new Error('useKanbanActions must be used within a KanbanProvider');
  }
  return context;
}

/** Board data and commands, for consumers that render from the data anyway. */
export function useKanban(): KanbanState & KanbanActions {
  return { ...useKanbanState(), ...useKanbanActions() };
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
  const unreadMailCounts = useWorkspaceUnreadCounts(projectId);
  const {
    data: projectWorkspaces,
    isLoading: isLoadingWorkspaces,
    error: errorWorkspaces,
    isFetching: isFetchingWorkspaces,
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
  const renameMutation = useRenameWorkspace(projectId);
  const archiveCommand = useWorkspaceArchiveCommand();
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
    refetch: refetchProjectIssues,
  } = useProjectIssues(projectId, issueProvider, {
    // Deliberately the unfiltered list: `workspaces` drops null-column
    // workspaces for the board's benefit, and an archiving workspace still owns
    // its issue until the archive completes.
    workspaceIssueLinks: projectWorkspaces?.workspaces,
    optimisticWorkspaceIssueLinks: archivingWorkspaceIssueLinks,
  });
  const [showInlineForm, setShowInlineForm] = useState(false);
  const [inlineFormRequest, setInlineFormRequest] = useState(0);
  const [quickChatWorkspaceId, setQuickChatWorkspaceId] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const offerGitLockRecovery = (workspaceIds: readonly string[]) =>
    setArchiveGitLockWorkspaceIds((current) => [...new Set([...current, ...workspaceIds])]);

  const handleArchiveError = (error: unknown, workspaceIds: string[]) => {
    if (isArchiveGitIndexLockedError(error)) {
      offerGitLockRecovery(workspaceIds);
      return;
    }
    toast.error(archiveErrorMessage(error) ?? "Couldn't archive workspace");
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

  // Commands read this render's values through useStableCallback, so each
  // keeps one identity and the memoized cards skip unrelated board updates.
  const refetchIssues = useStableCallback(() => {
    void refetchProjectIssues();
  });

  const refetch = useStableCallback(() => {
    runInBackground(refetchWorkspaces());
    runInBackground(refetchProjectIssues());
  });

  const syncAndRefetch = useStableCallback(() => {
    // An explicit Sync click bypasses the automatic refresh throttles.
    syncMutation.mutate({ projectId, force: true });
    refetch();
  });

  const toggleWorkspaceRatcheting = useStableCallback((workspaceId: string, enabled: boolean) => {
    // Pending state, settle-time invalidation and the error toast live in the
    // shared useToggleRatcheting hook.
    toggleRatchetingMutation.mutate({ workspaceId, enabled });
  });

  // Resolves once the renamed workspace has refetched (see useRenameWorkspace).
  const renameWorkspace = useStableCallback(async (workspaceId: string, name: string) => {
    await renameMutation.mutateAsync({ id: workspaceId, name });
  });

  const archiveWorkspace = useStableCallback(
    async (workspaceId: string, removeGitIndexLock?: boolean) => {
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
          removeGitIndexLock: removeGitIndexLock ?? false,
        });
        handleArchiveOutcomes(outcomes);
      } finally {
        releaseIssueSuppression();
      }
    }
  );

  const archiveWorkspaces = useStableCallback(async (ids: readonly string[]) => {
    const requestedIds = [...new Set(ids)];
    const listed = new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace]));
    const names = new Map(requestedIds.map((id) => [id, listed.get(id)?.name ?? id]));
    const releaseIssueSuppression = suppressArchiveIssues(
      new Map(
        requestedIds.map((id) => [
          id,
          {
            githubIssueNumber:
              listed.get(id)?.githubIssueNumber ??
              archivingWorkspaceIssueLinks.get(id)?.githubIssueNumber ??
              null,
            linearIssueId:
              listed.get(id)?.linearIssueId ??
              archivingWorkspaceIssueLinks.get(id)?.linearIssueId ??
              null,
          },
        ])
      )
    );

    try {
      const outcomes = await archiveCommand.archiveWorkspaces({ projectId, ids: requestedIds });
      const failures = outcomes.filter((outcome) => !outcome.success);
      offerGitLockRecovery(
        failures
          .filter((failure) => isArchiveGitIndexLockedError(failure.error))
          .map((failure) => failure.id)
      );
      reportArchiveFailures(
        failures
          .filter((failure) => !isArchiveGitIndexLockedError(failure.error))
          .map((failure) => ({ ...failure, name: names.get(failure.id) ?? failure.id }))
      );
      return { failedIds: failures.map((failure) => failure.id) };
    } finally {
      releaseIssueSuppression();
    }
  });

  const retryGitLockedArchives = useStableCallback(async (removeGitIndexLock: boolean) => {
    const workspaceIds = archiveGitLockWorkspaceIds;
    setArchiveGitLockWorkspaceIds([]);
    for (const workspaceId of workspaceIds) {
      await archiveWorkspace(workspaceId, removeGitIndexLock);
    }
  });

  const actions = useMemo<KanbanActions>(
    () => ({
      refetchIssues,
      refetch,
      syncAndRefetch,
      toggleWorkspaceRatcheting,
      renameWorkspace,
      archiveWorkspace,
      archiveWorkspaces,
      startSelecting: () => setIsSelecting(true),
      stopSelecting: () => setIsSelecting(false),
      dismissArchiveGitLock: () => setArchiveGitLockWorkspaceIds([]),
      retryGitLockedArchives,
      setShowInlineForm,
      requestInlineForm: () => {
        setShowInlineForm(true);
        setInlineFormRequest((count) => count + 1);
      },
      openQuickChat: setQuickChatWorkspaceId,
      closeQuickChat: () => setQuickChatWorkspaceId(null),
    }),
    []
  );

  const visibleWorkspaces = useMemo(
    () => workspaces?.filter((workspace) => !archivingWorkspaceIssueLinks.has(workspace.id)),
    [workspaces, archivingWorkspaceIssueLinks]
  );
  const errorMessage = errorWorkspaces?.message;
  const isArchiving =
    archiveIssueOperations.size > 0 || archiveCommand.isArchiving || archiveCommand.isBulkArchiving;

  const state = useMemo<KanbanState>(
    () => ({
      projectId,
      projectSlug,
      unreadMailCounts: unreadMailCounts.data,
      issueProvider,
      workspaces: visibleWorkspaces,
      issues,
      issuesStatus,
      isFetchingIssues,
      issuesError,
      isLoading: isLoadingWorkspaces,
      error: errorMessage === undefined ? null : { message: errorMessage },
      isFetching: isFetchingWorkspaces,
      isSyncing: syncMutation.isPending,
      togglingWorkspaceIds: toggleRatchetingMutation.pendingWorkspaceIds,
      archiveGitLockWorkspaceIds,
      isBulkArchiving: archiveCommand.isBulkArchiving,
      isArchiving,
      isSelecting,
      showInlineForm,
      inlineFormRequest,
      quickChatWorkspaceId,
    }),
    [
      projectId,
      projectSlug,
      unreadMailCounts.data,
      issueProvider,
      visibleWorkspaces,
      issues,
      issuesStatus,
      isFetchingIssues,
      issuesError,
      isLoadingWorkspaces,
      errorMessage,
      isFetchingWorkspaces,
      syncMutation.isPending,
      toggleRatchetingMutation.pendingWorkspaceIds,
      archiveGitLockWorkspaceIds,
      archiveCommand.isBulkArchiving,
      isArchiving,
      isSelecting,
      showInlineForm,
      inlineFormRequest,
      quickChatWorkspaceId,
    ]
  );

  return (
    <KanbanActionsContext value={actions}>
      <KanbanStateContext value={state}>
        {children}
        {toggleRatchetingMutation.recipientPicker}
      </KanbanStateContext>
    </KanbanActionsContext>
  );
}
