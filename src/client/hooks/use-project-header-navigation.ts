import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  getProjectSlugFromPath,
  useAppNavigationDataContext,
} from '@/client/hooks/use-app-navigation-data';

export function useProjectHeaderNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { projects, selectedProjectSlug, selectProjectSlug } = useAppNavigationDataContext();
  const currentProjectSlug = getProjectSlugFromPath(pathname) ?? selectedProjectSlug;

  const navigateToProject = useCallback(
    (slug: string) => {
      selectProjectSlug(slug);
      void navigate(`/projects/${slug}/workspaces`);
    },
    [navigate, selectProjectSlug]
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
    navigateToProject(currentProjectSlug);
  }, [currentProjectSlug, navigateToProject]);

  return {
    selectedProjectSlug: currentProjectSlug,
    projects,
    handleProjectChange,
    handleCurrentProjectSelect,
  };
}
