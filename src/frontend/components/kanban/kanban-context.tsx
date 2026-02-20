import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import {
  type NormalizedIssue,
  normalizeGitHubIssue,
  normalizeLinearIssue,
} from '@/frontend/lib/issue-normalization';
import { trpc } from '@/frontend/lib/trpc';
import type { WorkspaceWithKanban } from './kanban-card';

/** @deprecated Use `NormalizedIssue` from `@/frontend/lib/issue-normalization` instead. */
export type KanbanIssue = NormalizedIssue;

interface ArchivingWorkspaceIssueLink {
  githubIssueNumber: number | null;
  linearIssueId: string | null;
}

function collectLinearIssueIds(
  workspaces: WorkspaceWithKanban[] | undefined,
  archivingWorkspaceIssueLinks: Map<string, ArchivingWorkspaceIssueLink>
): Set<string> {
  const issueIds = new Set(
    (workspaces ?? [])
      .map((workspace) => workspace.linearIssueId)
      .filter((id): id is string => id !== null)
  );
  for (const link of archivingWorkspaceIssueLinks.values()) {
    if (link.linearIssueId) {
      issueIds.add(link.linearIssueId);
    }
  }
  return issueIds;
}

function collectGitHubIssueNumbers(
  workspaces: WorkspaceWithKanban[] | undefined,
  archivingWorkspaceIssueLinks: Map<string, ArchivingWorkspaceIssueLink>
): Set<number> {
  const issueNumbers = new Set(
    (workspaces ?? [])
      .map((workspace) => workspace.githubIssueNumber)
      .filter((issueNumber): issueNumber is number => issueNumber !== null)
  );
  for (const link of archivingWorkspaceIssueLinks.values()) {
    if (link.githubIssueNumber) {
      issueNumbers.add(link.githubIssueNumber);
    }
  }
  return issueNumbers;
}

interface KanbanContextValue {
  projectId: string;
  projectSlug: string;
  issueProvider: string;
  workspaces: WorkspaceWithKanban[] | undefined;
  issues: KanbanIssue[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => void;
  syncAndRefetch: () => Promise<void>;
  isSyncing: boolean;
  toggleWorkspaceRatcheting: (workspaceId: string, enabled: boolean) => Promise<void>;
  togglingWorkspaceId: string | null;
  archiveWorkspace: (workspaceId: string, commitUncommitted: boolean) => Promise<void>;
  bulkArchiveColumn: (kanbanColumn: string, commitUncommitted: boolean) => Promise<void>;
  isBulkArchiving: boolean;
  showInlineForm: boolean;
  setShowInlineForm: (show: boolean) => void;
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
  issueProvider: string;
  children: ReactNode;
}

export function KanbanProvider({
  projectId,
  projectSlug,
  issueProvider,
  children,
}: KanbanProviderProps) {
  const utils = trpc.useUtils();
  const isLinear = issueProvider === 'LINEAR';

  const {
    data: workspaces,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
    refetch: refetchWorkspaces,
  } = trpc.workspace.listWithKanbanState.useQuery(
    { projectId },
    { refetchInterval: 30_000, staleTime: 25_000 }
  );

  // GitHub issues — enabled only when provider is GitHub
  const {
    data: githubIssuesData,
    isLoading: isLoadingGithubIssues,
    refetch: refetchGithubIssues,
  } = trpc.github.listIssuesForProject.useQuery(
    { projectId },
    { refetchInterval: 60_000, staleTime: 30_000, enabled: !isLinear }
  );

  // Linear issues — enabled only when provider is Linear
  const {
    data: linearIssuesData,
    isLoading: isLoadingLinearIssues,
    refetch: refetchLinearIssues,
  } = trpc.linear.listIssuesForProject.useQuery(
    { projectId },
    { refetchInterval: 60_000, staleTime: 30_000, enabled: isLinear }
  );

  const isLoadingIssues = isLinear ? isLoadingLinearIssues : isLoadingGithubIssues;

  const syncMutation = trpc.workspace.syncAllPRStatuses.useMutation();
  const toggleRatchetingMutation = trpc.workspace.toggleRatcheting.useMutation();
  const archiveMutation = trpc.workspace.archive.useMutation();
  const bulkArchiveMutation = trpc.workspace.bulkArchive.useMutation();
  const [togglingWorkspaceId, setTogglingWorkspaceId] = useState<string | null>(null);
  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<Set<string>>(new Set());
  const [archivingWorkspaceIssueLinks, setArchivingWorkspaceIssueLinks] = useState<
    Map<string, ArchivingWorkspaceIssueLink>
  >(new Map());
  const [showInlineForm, setShowInlineForm] = useState(false);

  const refetchIssues = isLinear ? refetchLinearIssues : refetchGithubIssues;

  const syncAndRefetch = async () => {
    await syncMutation.mutateAsync({ projectId });
    refetchWorkspaces();
    refetchIssues();
  };

  const toggleWorkspaceRatcheting = async (workspaceId: string, enabled: boolean) => {
    setTogglingWorkspaceId(workspaceId);
    try {
      await toggleRatchetingMutation.mutateAsync({ workspaceId, enabled });
      await Promise.all([
        refetchWorkspaces(),
        utils.workspace.getProjectSummaryState.invalidate({ projectId }),
        utils.workspace.get.invalidate({ id: workspaceId }),
      ]);
    } finally {
      setTogglingWorkspaceId(null);
    }
  };

  const archiveWorkspace = async (workspaceId: string, commitUncommitted: boolean) => {
    const workspace = workspaces?.find((item) => item.id === workspaceId);
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
      await archiveMutation.mutateAsync({ id: workspaceId, commitUncommitted });
      await Promise.all([
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
    await bulkArchiveMutation.mutateAsync({
      projectId,
      kanbanColumn: kanbanColumn as 'WORKING' | 'WAITING' | 'DONE',
      commitUncommitted,
    });
    await refetchWorkspaces();
  };

  const refetch = () => {
    refetchWorkspaces();
    refetchIssues();
  };

  const visibleWorkspaces = useMemo(
    () => workspaces?.filter((workspace) => !archivingWorkspaceIds.has(workspace.id)),
    [workspaces, archivingWorkspaceIds]
  );

  // Normalize issues from the active provider
  const normalizedIssues = useMemo(() => {
    if (isLinear) {
      return linearIssuesData?.issues?.map(normalizeLinearIssue);
    }
    return githubIssuesData?.issues?.map(normalizeGitHubIssue);
  }, [isLinear, githubIssuesData?.issues, linearIssuesData?.issues]);

  // Filter out issues that already have a workspace
  const filteredIssues = useMemo(() => {
    if (!normalizedIssues) {
      return undefined;
    }

    if (isLinear) {
      const workspaceLinearIds = collectLinearIssueIds(workspaces, archivingWorkspaceIssueLinks);
      return normalizedIssues.filter(
        (issue) => !(issue.linearIssueId && workspaceLinearIds.has(issue.linearIssueId))
      );
    }

    const workspaceIssueNumbers = collectGitHubIssueNumbers(
      workspaces,
      archivingWorkspaceIssueLinks
    );
    return normalizedIssues.filter(
      (issue) => !(issue.githubIssueNumber && workspaceIssueNumbers.has(issue.githubIssueNumber))
    );
  }, [normalizedIssues, workspaces, isLinear, archivingWorkspaceIssueLinks]);

  return (
    <KanbanContext.Provider
      value={{
        projectId,
        projectSlug,
        issueProvider,
        workspaces: visibleWorkspaces as WorkspaceWithKanban[] | undefined,
        issues: filteredIssues,
        isLoading: isLoadingWorkspaces || isLoadingIssues,
        isError: isErrorWorkspaces,
        error: errorWorkspaces ? { message: errorWorkspaces.message } : null,
        refetch,
        syncAndRefetch,
        isSyncing: syncMutation.isPending,
        toggleWorkspaceRatcheting,
        togglingWorkspaceId,
        archiveWorkspace,
        bulkArchiveColumn,
        isBulkArchiving: bulkArchiveMutation.isPending,
        showInlineForm,
        setShowInlineForm,
      }}
    >
      {children}
    </KanbanContext.Provider>
  );
}
