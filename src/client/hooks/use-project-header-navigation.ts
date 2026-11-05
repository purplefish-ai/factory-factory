import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  getProjectSlugFromPath,
  useAppNavigationDataContext,
} from '@/client/hooks/use-app-navigation-data';
import { getProjectSectionPath, getProjectSwitchPath } from '@/client/lib/project-navigation';

export function useProjectHeaderNavigation() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const {
    projects,
    projectsError,
    refetchProjects,
    selectedProjectSlug,
    selectProjectSlug,
    serverWorkspaces,
  } = useAppNavigationDataContext();
  const currentProjectSlug = getProjectSlugFromPath(pathname) ?? selectedProjectSlug;

  const navigateToProject = useCallback(
    (slug: string) => {
      selectProjectSlug(slug);
      void navigate(getProjectSwitchPath(slug, pathname, search));
    },
    [navigate, pathname, search, selectProjectSlug]
  );

  const handleProjectChange = useCallback(
    (value: string) => {
      if (value === '__manage__') {
        void navigate('/projects');
        return;
      }
      if (value === '__create__') {
        void navigate('/projects/new');
        return;
      }
      navigateToProject(value);
    },
    [navigate, navigateToProject]
  );

  const handleCurrentProjectSelect = useCallback(() => {
    if (!currentProjectSlug) {
      return;
    }
    selectProjectSlug(currentProjectSlug);
    void navigate(getProjectSectionPath(currentProjectSlug, 'workspaces'));
  }, [currentProjectSlug, navigate, selectProjectSlug]);

  return {
    boardCounts:
      currentProjectSlug === selectedProjectSlug && serverWorkspaces !== undefined
        ? {
            working: serverWorkspaces.filter((workspace) => workspace.kanbanColumn === 'WORKING')
              .length,
            waiting: serverWorkspaces.filter((workspace) => workspace.kanbanColumn === 'WAITING')
              .length,
          }
        : undefined,
    selectedProjectSlug: currentProjectSlug,
    projects,
    projectsError,
    refetchProjects,
    handleProjectChange,
    handleCurrentProjectSelect,
  };
}
