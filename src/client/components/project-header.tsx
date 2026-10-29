import { HeaderLeftStartSlot, useAppHeader } from '@/client/components/app-header-context';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import { useProjectHeaderNavigation } from '@/client/hooks/use-project-header-navigation';

export interface ProjectNavigationProject {
  id: string;
  slug: string;
  name: string;
}

/** Inline project selector for headers which already own the left portal. */
export function ProjectHeaderNavigation({
  project,
  showTrailingSlash = false,
  triggerId = 'header-project-select',
}: {
  project: ProjectNavigationProject;
  showTrailingSlash?: boolean;
  triggerId?: string;
}) {
  const {
    projects,
    handleProjectChange,
    handleCurrentProjectSelect,
    projectsError,
    refetchProjects,
  } = useProjectHeaderNavigation();
  const menuProjects = projects?.some((candidate) => candidate.id === project.id)
    ? projects
    : [project, ...(projects ?? [])];
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ProjectSelectorDropdown
        selectedProjectSlug={project.slug}
        onProjectChange={handleProjectChange}
        onCurrentProjectSelect={handleCurrentProjectSelect}
        projects={menuProjects}
        showLeadingSlash
        showTrailingSlash={showTrailingSlash}
        triggerId={triggerId}
      />
      {projectsError ? (
        <>
          <span role="alert" className="sr-only">
            Could not load projects: {projectsError.message}
          </span>
          <button
            type="button"
            className="shrink-0 whitespace-nowrap text-xs text-destructive underline"
            title={projectsError.message}
            onClick={() => {
              void refetchProjects();
            }}
          >
            Retry projects
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Shared project navbar; callers resolve the URL project before rendering. */
export function ProjectHeader({ project }: { project: ProjectNavigationProject }) {
  useAppHeader({ title: '' });
  return (
    <HeaderLeftStartSlot>
      <ProjectHeaderNavigation project={project} />
    </HeaderLeftStartSlot>
  );
}
