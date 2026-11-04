import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CaretUpDownIcon } from '@phosphor-icons/react/dist/csr/CaretUpDown';
import { type MouseEvent, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { getProjectSection, getProjectSectionPath } from '@/client/lib/project-navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const DEFAULT_PROJECT_BUTTON_CLASS =
  'h-7 w-auto max-w-[6rem] border-0 bg-transparent px-0.5 text-sm font-semibold text-foreground shadow-none focus:ring-0 sm:max-w-[18rem] sm:px-1';

function getProjectInitials(name: string): string {
  const tokens = name
    .trim()
    .split(/[\s\-_/.]+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return name;
  }

  if (tokens.length === 1) {
    return tokens[0]?.slice(0, 2).toUpperCase() ?? name;
  }

  return tokens
    .slice(0, 3)
    .map((token) => token[0]?.toUpperCase() ?? '')
    .join('');
}

export function ProjectSelectorDropdown({
  selectedProjectSlug,
  onProjectChange,
  projects,
  triggerClassName,
  projectButtonClassName,
  triggerId = 'project-select',
  onCurrentProjectSelect,
  onRetryProjects,
  showLeadingSlash = false,
  showTrailingSlash = false,
  trailingSeparatorType = 'chevron',
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  triggerClassName?: string;
  projectButtonClassName?: string;
  triggerId?: string;
  onCurrentProjectSelect?: () => void;
  onRetryProjects?: () => void;
  showLeadingSlash?: boolean;
  showTrailingSlash?: boolean;
  trailingSeparatorType?: 'chevron' | 'slash';
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const selectedProject = projects?.find((project) => project.slug === selectedProjectSlug);
  const selectedProjectName = selectedProject?.name ?? 'Select a project';
  const projectButtonLabel =
    isMobile && selectedProject ? getProjectInitials(selectedProject.name) : selectedProjectName;
  const { pathname } = useLocation();
  const section = getProjectSection(pathname) ?? 'workspaces';

  // Keep browser link behavior for new tabs/windows and middle clicks. Only
  // ordinary activation changes this tab's persisted project selection.
  const activateLink = (event: MouseEvent<HTMLAnchorElement>, action: () => void) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    setOpen(false);
    action();
  };

  const handleCurrentProjectClick = () => {
    onCurrentProjectSelect?.();
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {showLeadingSlash ? (
        <span className="hidden shrink-0 text-muted-foreground md:inline-flex" aria-hidden>
          <CaretRightIcon className="h-3.5 w-3.5" />
        </span>
      ) : null}
      <button
        type="button"
        onClick={handleCurrentProjectClick}
        disabled={!onCurrentProjectSelect}
        className={cn(
          'min-w-0 truncate text-left',
          onCurrentProjectSelect
            ? 'cursor-pointer hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline'
            : 'cursor-default',
          DEFAULT_PROJECT_BUTTON_CLASS,
          projectButtonClassName
        )}
        title={selectedProjectName}
        aria-label={`Open ${selectedProjectName} workspaces`}
      >
        {projectButtonLabel}
      </button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          id={triggerId}
          aria-label="Open project menu"
          className={cn(
            'h-7 w-6 shrink-0 border-0 bg-transparent px-0.5 text-muted-foreground shadow-none focus:ring-0 md:w-7 md:px-1 [&>svg:last-of-type]:hidden',
            triggerClassName
          )}
        >
          <span className="sr-only">Open project menu</span>
          <span className="inline-flex items-center text-current" aria-hidden>
            <CaretUpDownIcon className="h-3 w-3 opacity-70 md:h-3.5 md:w-3.5" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
          {projects?.map((project) => {
            const isCurrent = project.slug === selectedProjectSlug;
            const openCurrent = isCurrent && onCurrentProjectSelect;
            return (
              <DropdownMenuItem key={project.id} asChild>
                <Link
                  to={getProjectSectionPath(project.slug, openCurrent ? 'workspaces' : section)}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={(event) =>
                    activateLink(event, () => {
                      if (openCurrent) {
                        onCurrentProjectSelect();
                      } else {
                        onProjectChange(project.slug);
                      }
                    })
                  }
                  className="break-words"
                >
                  {project.name}
                </Link>
              </DropdownMenuItem>
            );
          })}
          {onRetryProjects ? (
            <DropdownMenuItem onSelect={onRetryProjects} className="text-destructive">
              Retry projects
            </DropdownMenuItem>
          ) : null}
          {projects?.length || onRetryProjects ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem asChild>
            <Link
              to="/projects/new"
              onClick={(event) => activateLink(event, () => onProjectChange('__create__'))}
            >
              + Create project
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link
              to="/projects"
              onClick={(event) => activateLink(event, () => onProjectChange('__manage__'))}
            >
              Manage projects…
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {showTrailingSlash ? (
        <span className="-ml-0.5 shrink-0 text-muted-foreground" aria-hidden>
          {trailingSeparatorType === 'slash' ? (
            <span className="text-xs">/</span>
          ) : (
            <CaretRightIcon className="h-3.5 w-3.5" />
          )}
        </span>
      ) : null}
    </div>
  );
}
