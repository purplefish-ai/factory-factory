import { useProjectHeaderNavigation } from '@/client/hooks/use-project-header-navigation';

export function useWorkspaceProjectNavigation() {
  const { selectedProjectSlug, projects, handleProjectChange, handleCurrentProjectSelect } =
    useProjectHeaderNavigation();

  return {
    slug: selectedProjectSlug,
    projects,
    handleProjectChange,
    handleCurrentProjectSelect,
  };
}
