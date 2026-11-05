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
    selectedProjectSlug: currentProjectSlug,
    projects: projects?.map((project) =>
      project.slug === selectedProjectSlug && serverWorkspaces !== undefined
        ? {
            ...project,
            boardCounts: {
              working: serverWorkspaces.filter((workspace) => workspace.kanbanColumn === 'WORKING')
                .length,
              waiting: serverWorkspaces.filter((workspace) => workspace.kanbanColumn === 'WAITING')
                .length,
            },
          }
        : project
    ),
    handleProjectMenuOpen: () => {
      if (!projectsError) {
        // Query errors appear through the existing retry item, including failed refreshes.
        void Promise.resolve(refetchProjects?.()).catch(() => undefined);
      }
    },
    projectsError,
    refetchProjects,
    handleProjectChange,
    handleCurrentProjectSelect,
  };
}
