import { Link, useLocation } from 'react-router';
import { HeaderLeftStartSlot, useAppHeader } from '@/client/components/app-header-context';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import { useProjectHeaderNavigation } from '@/client/hooks/use-project-header-navigation';
import {
  getProjectSection,
  getProjectSectionPath,
  type ProjectSection,
} from '@/client/lib/project-navigation';
import { cn } from '@/lib/utils';

export interface ProjectNavigationProject {
  id: string;
  slug: string;
  name: string;
}

/** Inline composition for workspace headers which already own the left portal. */
export function ProjectSectionNavigation({ project }: { project: ProjectNavigationProject }) {
  const {
    projects,
    handleProjectChange,
    handleCurrentProjectSelect,
    reviewCount,
    projectsError,
    refetchProjects,
  } = useProjectHeaderNavigation();
  const { pathname } = useLocation();
  const section = getProjectSection(pathname);
  // An explicit archived project remains the visible current project.
  const menuProjects = projects?.some((candidate) => candidate.id === project.id)
    ? projects
    : [project, ...(projects ?? [])];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 sm:gap-3">
      <ProjectSelectorDropdown
        selectedProjectSlug={project.slug}
        onProjectChange={handleProjectChange}
        onCurrentProjectSelect={handleCurrentProjectSelect}
        projects={menuProjects}
        showLeadingSlash
        triggerId="header-project-select"
      />
      <nav aria-label="Project sections" className="flex shrink-0 items-center gap-0.5">
        {(['workspaces', 'agents', 'reviews'] satisfies ProjectSection[]).map((item) => (
          <Link
            key={item}
            to={getProjectSectionPath(project.slug, item)}
            aria-current={section === item ? 'page' : undefined}
            className={cn(
              'rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2',
              section === item && 'bg-muted font-medium text-foreground'
            )}
          >
            {item.charAt(0).toUpperCase() + item.slice(1)}
            {item === 'reviews' && reviewCount > 0 ? (
              <span className="ml-1 rounded bg-orange-500/20 px-1 text-[10px] text-orange-600">
                {reviewCount}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      {projectsError ? (
        <>
          <span role="alert" className="sr-only">
            Could not load projects: {projectsError.message}
          </span>
          <button
            type="button"
            className="text-xs text-destructive underline"
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
export function ProjectSectionHeader({ project }: { project: ProjectNavigationProject }) {
  useAppHeader({ title: '' });
  return (
    <HeaderLeftStartSlot>
      <ProjectSectionNavigation project={project} />
    </HeaderLeftStartSlot>
  );
}
