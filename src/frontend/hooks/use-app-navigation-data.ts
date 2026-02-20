import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useProjectSnapshotSync } from '@/frontend/hooks/use-project-snapshot-sync';
import { useWorkspaceAttention } from '@/frontend/hooks/use-workspace-attention';
import { useProjectContext } from '@/frontend/lib/providers';
import { trpc } from '@/frontend/lib/trpc';

const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match ? (match[1] as string) : null;
}

function getInitialProjectSlug(): string {
  const slugFromPath = getProjectSlugFromPath(window.location.pathname);
  if (slugFromPath && slugFromPath !== 'new') {
    return slugFromPath;
  }
  return localStorage.getItem(SELECTED_PROJECT_KEY) || '';
}

/**
 * Syncs PR statuses when project changes.
 */
function usePRStatusSync(
  selectedProjectId: string | undefined,
  utils: ReturnType<typeof trpc.useUtils>
) {
  const syncAllPRStatuses = trpc.workspace.syncAllPRStatuses.useMutation({
    onSuccess: () => {
      utils.workspace.getProjectSummaryState.invalidate({ projectId: selectedProjectId });
    },
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
  setSelectedProjectSlug: (slug: string) => void
) {
  useEffect(() => {
    const slugFromPath = getProjectSlugFromPath(pathname);
    const hasValidSlugInPath = slugFromPath && slugFromPath !== 'new';

    if (hasValidSlugInPath) {
      setSelectedProjectSlug(slugFromPath);
      localStorage.setItem(SELECTED_PROJECT_KEY, slugFromPath);
    } else {
      const stored = localStorage.getItem(SELECTED_PROJECT_KEY);
      if (stored) {
        setSelectedProjectSlug(stored);
      }
    }
  }, [pathname, setSelectedProjectSlug]);

  // Select first project if none selected
  useEffect(() => {
    if (!projects || projects.length === 0 || selectedProjectSlug) {
      return;
    }

    const firstSlug = projects[0]?.slug;
    if (firstSlug) {
      setSelectedProjectSlug(firstSlug);
      localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
    }
  }, [projects, selectedProjectSlug, setSelectedProjectSlug]);
}

/**
 * Central hook providing all navigation-level data previously owned by AppSidebar.
 * Used by AppLayout, AppSidebar, and AppHeader.
 */
export function useAppNavigationData() {
  const { pathname } = useLocation();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string>(getInitialProjectSlug);
  const { setProjectContext } = useProjectContext();

  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });

  const selectedProject = projects?.find((p) => p.slug === selectedProjectSlug);
  const selectedProjectId = selectedProject?.id;
  const issueProvider = selectedProject?.issueProvider ?? 'GITHUB';

  const { data: projectState } = trpc.workspace.getProjectSummaryState.useQuery(
    { projectId: selectedProjectId ?? '' },
    { enabled: !!selectedProjectId, refetchInterval: 30_000 }
  );

  const utils = trpc.useUtils();

  // Sync PR statuses from GitHub once when project changes
  usePRStatusSync(selectedProjectId, utils);

  // Sync workspace snapshots from WebSocket to React Query cache
  useProjectSnapshotSync(selectedProjectId);

  // Track workspaces that need user attention
  const { needsAttention, clearAttention } = useWorkspaceAttention();

  // Sync slug from URL
  useProjectSlugSync(pathname, projects, selectedProjectSlug, setSelectedProjectSlug);

  // Set project context for tRPC headers
  useEffect(() => {
    if (selectedProjectId) {
      setProjectContext(selectedProjectId);
    }
  }, [selectedProjectId, setProjectContext]);

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
    selectedProjectId,
    issueProvider,
    serverWorkspaces,
    reviewCount,
    needsAttention,
    clearAttention,
    currentWorkspaceId,
  };
}
