import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { useLocation } from 'react-router';
import { HeaderLeftStartSlot, useAppHeader } from '@/client/components/app-header-context';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import { useProjectHeaderNavigation } from '@/client/hooks/use-project-header-navigation';
import { getProjectSection } from '@/client/lib/project-navigation';

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
        onRetryProjects={
          projectsError
            ? () => {
                void refetchProjects();
              }
            : undefined
        }
      />
      {projectsError ? (
        <span role="alert" className="sr-only">
          Couldn't load projects. {projectsError.message}
        </span>
      ) : null}
    </div>
  );
}

/** Shared project navbar; callers resolve the URL project before rendering. */
export function ProjectHeader({ project }: { project: ProjectNavigationProject }) {
  useAppHeader({ title: '' });
  const { pathname } = useLocation();
  const section = getProjectSection(pathname);
  const sectionLabel =
    section === 'workspaces'
      ? 'Board'
      : section === 'agents'
        ? 'Agents'
        : section === 'reviews'
          ? 'Reviews'
          : null;
  return (
    <HeaderLeftStartSlot>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
        <ProjectHeaderNavigation project={project} />
        {sectionLabel ? (
          <>
            <CaretRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span aria-current="page" className="truncate text-sm font-semibold">
              {sectionLabel}
            </span>
          </>
        ) : null}
      </nav>
    </HeaderLeftStartSlot>
  );
}
