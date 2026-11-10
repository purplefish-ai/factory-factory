import type { RefetchOptions } from '@tanstack/react-query';
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';
import { useWorkspaceUnreadCounts } from '@/client/features/inbox';
import { useCombinedAgentSummary } from '@/client/hooks/use-combined-agent-summary';
import {
  getReviewRepository,
  useProjectReviewRequests,
} from '@/client/hooks/use-project-review-requests';
import { useProjectSnapshotSync } from '@/client/hooks/use-project-snapshot-sync';
import { useProjectWorkspaceQuery } from '@/client/hooks/use-project-workspace-query';
import { useStableCallback } from '@/client/hooks/use-stable-callback';
import { useWorkspaceAttention } from '@/client/hooks/use-workspace-attention';
import { readSelectedProjectSlug, writeSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import type { WorkspaceSummary } from '@/shared/workspace-summary';

export function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/i);
  const segment = match?.[1];
  if (!segment || /^\/projects\/new\/?$/i.test(pathname)) {
    return null;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isProjectSettingsPath(pathname: string): boolean {
  return /^\/projects\/[^/]+\/settings\/?$/i.test(pathname);
}

function persistSelectedProjectSlug(slug: string) {
  writeSelectedProjectSlug(slug);
}

function getInitialProjectSlug(): string {
  const pathname = window.location.pathname;
  return (
    (isProjectSettingsPath(pathname) ? null : getProjectSlugFromPath(pathname)) ??
    readSelectedProjectSlug() ??
    ''
  );
}

/**
 * Syncs PR statuses when the app loads or the project changes. This sweep is
 * automatic, so it is unforced: the server skips merged PRs, recently closed
 * PRs, and PRs observed in the last 90 seconds. The scheduler's first pass runs
 * three minutes after startup, so this keeps launch data fresh without a burst.
 */
function usePRStatusSync(selectedProjectId: string | undefined) {
  const syncAllPRStatuses = trpc.workspace.syncAllPRStatuses.useMutation({
    onError: (error) => toast.error(`Couldn't sync PR statuses. ${error.message}`),
  });
  const lastSyncedProjectRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedProjectId && selectedProjectId !== lastSyncedProjectRef.current) {
      lastSyncedProjectRef.current = selectedProjectId;
      syncAllPRStatuses.mutate({ projectId: selectedProjectId, force: false });
    }
  }, [selectedProjectId, syncAllPRStatuses]);
}

/**
 * Syncs project slug from URL and falls back to localStorage/first project.
 */
function useProjectSlugSync(
  pathname: string,
  projects: Array<{ id: string; slug: string; name: string }> | undefined,
  selectedProjectSlug: string,
  selectProjectSlug: (slug: string) => void
) {
  useEffect(() => {
    // Project settings have their own URL owner without changing the global Board selection.
    if (isProjectSettingsPath(pathname)) {
      return;
    }
    const slugFromPath = getProjectSlugFromPath(pathname);
    if (slugFromPath) {
      selectProjectSlug(slugFromPath);
    } else {
      const stored = readSelectedProjectSlug();
      if (stored) {
        selectProjectSlug(stored);
      }
    }
  }, [pathname, selectProjectSlug]);

  useEffect(() => {
    if (
      !projects ||
      projects.length === 0 ||
      (!isProjectSettingsPath(pathname) && getProjectSlugFromPath(pathname))
    ) {
      return;
    }

    if (selectedProjectSlug && projects.some((project) => project.slug === selectedProjectSlug)) {
      return;
    }

    const firstSlug = projects[0]?.slug;
    if (firstSlug) {
      selectProjectSlug(firstSlug);
    }
  }, [pathname, projects, selectedProjectSlug, selectProjectSlug]);
}

/**
 * Central hook providing all navigation-level data previously owned by AppSidebar.
 * Used by AppLayout, AppSidebar, and AppHeader.
 */
export function useAppNavigationData() {
  const { pathname } = useLocation();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>(getInitialProjectSlug);

  const {
    data: projects,
    error: projectsError,
    refetch: refetchProjectList,
  } = trpc.project.list.useQuery({ isArchived: false });
  const {
    data: projectsWithBoardCounts,
    error: boardCountsError,
    refetch: refetchBoardCounts,
  } = trpc.project.list.useQuery(
    { isArchived: false, includeBoardCounts: true },
    { enabled: false }
  );
  const selectProjectSlug = useCallback((slug: string) => {
    setSelectedProjectSlug(slug);
    persistSelectedProjectSlug(slug);
  }, []);

  const selectedProject = projects?.find((p) => p.slug === selectedProjectSlug);
  const selectedProjectId = selectedProject?.id;
  const unreadMailCounts = useWorkspaceUnreadCounts(selectedProjectId);
  const issueProvider = selectedProject?.issueProvider ?? 'GITHUB';

  const urlSlug = getProjectSlugFromPath(pathname);
  const urlProject = trpc.project.getBySlug.useQuery(
    { slug: urlSlug ?? '' },
    { enabled: !!urlSlug }
  );
  const reviewProject = urlSlug ? urlProject.data : selectedProject;
  const reviews = useProjectReviewRequests(reviewProject);
  const agentProject = urlSlug
    ? urlProject.data?.slug === urlSlug
      ? urlProject.data
      : undefined
    : selectedProject;
  const agentsSummary = useCombinedAgentSummary(agentProject?.id);
  const utils = trpc.useUtils();
  const previousReviewScope = useRef<{ id: string; repository: string | null } | null>(null);
  useEffect(() => {
    if (!reviewProject) {
      return;
    }
    const next = { id: reviewProject.id, repository: getReviewRepository(reviewProject) };
    const previous = previousReviewScope.current;
    previousReviewScope.current = next;
    if (previous && previous.id === next.id && previous.repository !== next.repository) {
      void utils.prReview.listReviewRequests.reset({ projectId: next.id });
    }
  }, [reviewProject, utils]);

  const {
    data: projectState,
    error: workspacesError,
    isFetching: isFetchingWorkspaces,
    refetch: refetchWorkspaces,
  } = useProjectWorkspaceQuery(selectedProjectId);

  // Sync PR statuses from GitHub once when project changes
  usePRStatusSync(selectedProjectId);

  // Sync workspace snapshots from WebSocket to React Query cache
  useProjectSnapshotSync(selectedProjectId);

  // Track workspaces that need user attention
  const { needsAttention, clearAttention } = useWorkspaceAttention();

  // Sync slug from URL/localStorage and keep stale selections from surviving project changes.
  useProjectSlugSync(pathname, projects, selectedProjectSlug, selectProjectSlug);

  const serverWorkspaces: WorkspaceSummary<Date>[] | undefined = projectState?.workspaces;
  const reviewCount = reviews.prs.filter((pr) => pr.reviewDecision !== 'APPROVED').length;

  // Get current workspace ID from URL
  const currentWorkspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];

  // Clear attention glow when viewing a workspace
  useEffect(() => {
    const shouldClearAttention = currentWorkspaceId && needsAttention(currentWorkspaceId);
    if (shouldClearAttention) {
      clearAttention(currentWorkspaceId);
    }
  }, [currentWorkspaceId, needsAttention, clearAttention]);

  const projectsWithCounts = useMemo(
    () =>
      projects?.map((project) => {
        const boardCounts = boardCountsError
          ? undefined
          : projectsWithBoardCounts?.find((candidate) => candidate.id === project.id)?.boardCounts;
        return { ...project, ...(boardCounts ? { boardCounts } : {}) };
      }),
    [projects, projectsWithBoardCounts, boardCountsError]
  );
  const refetchProjects = useStableCallback(
    async (options?: RefetchOptions & { includeBoardCounts?: boolean }) => {
      const [result] = await Promise.all([
        refetchProjectList(options),
        options?.includeBoardCounts ? refetchBoardCounts() : Promise.resolve(),
      ]);
      return result;
    }
  );
  const retryWorkspaces = useStableCallback(() => {
    void refetchWorkspaces();
  });
  const workspacesErrorMessage = workspacesError?.message;
  const isRetryingWorkspaces = workspacesErrorMessage !== undefined && isFetchingWorkspaces;
  const unreadMailCountsData = unreadMailCounts.data;

  // The layout re-renders for route and query changes that leave this data
  // alone; one value per change keeps the sidebar and headers from following.
  return useMemo(
    () => ({
      ...(unreadMailCountsData ? { unreadMailCounts: unreadMailCountsData } : {}),
      projects: projectsWithCounts,
      projectsError,
      refetchProjects,
      selectedProjectSlug,
      selectProjectSlug,
      selectedProjectId,
      issueProvider,
      serverWorkspaces,
      // Present only after a failed load, so the sidebar can tell it from an empty list.
      ...(workspacesErrorMessage === undefined
        ? {}
        : {
            serverWorkspacesError: {
              message: workspacesErrorMessage,
              isRetrying: isRetryingWorkspaces,
              retry: retryWorkspaces,
            },
          }),
      reviewCount,
      agentsSummary,
      needsAttention,
      clearAttention,
      currentWorkspaceId,
    }),
    [
      unreadMailCountsData,
      projectsWithCounts,
      projectsError,
      selectedProjectSlug,
      selectProjectSlug,
      selectedProjectId,
      issueProvider,
      serverWorkspaces,
      workspacesErrorMessage,
      isRetryingWorkspaces,
      reviewCount,
      agentsSummary,
      needsAttention,
      clearAttention,
      currentWorkspaceId,
    ]
  );
}

export type AppNavigationData = ReturnType<typeof useAppNavigationData>;

const AppNavigationDataContext = createContext<AppNavigationData | null>(null);

export function AppNavigationDataProvider({
  children,
  value,
}: {
  children?: ReactNode;
  value: AppNavigationData;
}) {
  return createElement(AppNavigationDataContext.Provider, { value }, children);
}

export function useAppNavigationDataContext() {
  const context = useContext(AppNavigationDataContext);
  if (!context) {
    throw new Error('useAppNavigationDataContext must be used within AppNavigationDataProvider');
  }
  return context;
}
