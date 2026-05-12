import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { trpc } from '@/client/lib/trpc';

const SELECTED_PROJECT_KEY = 'factoryfactory_selected_project_slug';

function getProjectSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  const slug = match?.[1];
  return slug && slug !== 'new' ? slug : null;
}

function getInitialProjectSlug(): string {
  return (
    getProjectSlugFromPath(window.location.pathname) ??
    localStorage.getItem(SELECTED_PROJECT_KEY) ??
    ''
  );
}

export function useProjectHeaderNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [selectedProjectSlug, setSelectedProjectSlug] = useState(getInitialProjectSlug);
  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });
  const currentProjectSlug = getProjectSlugFromPath(pathname) ?? selectedProjectSlug;

  useEffect(() => {
    const slugFromPath = getProjectSlugFromPath(pathname);
    if (slugFromPath) {
      setSelectedProjectSlug(slugFromPath);
      localStorage.setItem(SELECTED_PROJECT_KEY, slugFromPath);
      return;
    }

    const stored = localStorage.getItem(SELECTED_PROJECT_KEY);
    if (stored) {
      setSelectedProjectSlug(stored);
    }
  }, [pathname]);

  useEffect(() => {
    if (!projects || projects.length === 0) {
      return;
    }

    if (selectedProjectSlug && projects.some((project) => project.slug === selectedProjectSlug)) {
      return;
    }

    const firstSlug = projects[0]?.slug;
    if (firstSlug) {
      setSelectedProjectSlug(firstSlug);
      localStorage.setItem(SELECTED_PROJECT_KEY, firstSlug);
    }
  }, [projects, selectedProjectSlug]);

  const navigateToProject = useCallback(
    (slug: string) => {
      localStorage.setItem(SELECTED_PROJECT_KEY, slug);
      setSelectedProjectSlug(slug);
      void navigate(`/projects/${slug}/workspaces`);
    },
    [navigate]
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
