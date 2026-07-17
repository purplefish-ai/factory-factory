import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';
import { useProjectSnapshotSync } from '@/client/hooks/use-project-snapshot-sync';
import { useWorkspaceAttention } from '@/client/hooks/use-workspace-attention';
import { readSelectedProjectSlug, writeSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';

export function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  const slug = match?.[1];
  return slug && slug !== 'new' ? slug : null;
}

function persistSelectedProjectSlug(slug: string) {
  writeSelectedProjectSlug(slug);
}

function getInitialProjectSlug(): string {
  return getProjectSlugFromPath(window.location.pathname) ?? readSelectedProjectSlug() ?? '';
}

/**
 * Syncs PR statuses when project changes.
 */
function usePRStatusSync(selectedProjectId: string | undefined) {
  const syncAllPRStatuses = trpc.workspace.syncAllPRStatuses.useMutation({
    onError: (error) => toast.error(`Failed to sync PR statuses: ${error.message}`),
  });
  const lastSyncedProjectRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedProjectId && selectedProjectId !== lastSyncedProjectRef.current) {
      lastSyncedProjectRef.current = selectedProjectId;
      syncAllPRStatuses.mutate({ projectId: selectedProjectId });
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
    if (!projects || projects.length === 0 || getProjectSlugFromPath(pathname)) {
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

  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });
  const selectProjectSlug = useCallback((slug: string) => {
    setSelectedProjectSlug(slug);
    persistSelectedProjectSlug(slug);
  }, []);

  const selectedProject = projects?.find((p) => p.slug === selectedProjectSlug);
  const selectedProjectId = selectedProject?.id;
  const issueProvider = selectedProject?.issueProvider ?? 'GITHUB';

  const { data: projectState } = trpc.workspace.getProjectSummaryState.useQuery(
    { projectId: selectedProjectId ?? '' },
    {
      enabled: !!selectedProjectId,
      // Sidebar/project state is live-synced via /snapshots (useProjectSnapshotSync).
      // Keep tRPC query as bootstrap/fallback, not a periodic poller.
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    }
  );

  // Sync PR statuses from GitHub once when project changes
  usePRStatusSync(selectedProjectId);

  // Sync workspace snapshots from WebSocket to React Query cache
  useProjectSnapshotSync(selectedProjectId);

  // Track workspaces that need user attention
  const { needsAttention, clearAttention } = useWorkspaceAttention();

  // Sync slug from URL/localStorage and keep stale selections from surviving project changes.
  useProjectSlugSync(pathname, projects, selectedProjectSlug, selectProjectSlug);

  const serverWorkspaces = projectState?.workspaces;
  const reviewCount = projectState?.reviewCount ?? 0;

  // Get current workspace ID from URL
  const currentWorkspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1];

  // Clear attention glow when viewing a workspace
  useEffect(() => {
    const shouldClearAttention = currentWorkspaceId && needsAttention(currentWorkspaceId);
    if (shouldClearAttention) {
      clearAttention(currentWorkspaceId);
    }
  }, [currentWorkspaceId, needsAttention, clearAttention]);

  return {
    projects,
    selectedProjectSlug,
    selectProjectSlug,
    selectedProjectId,
    issueProvider,
    serverWorkspaces,
    reviewCount,
    needsAttention,
    clearAttention,
    currentWorkspaceId,
  };
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
