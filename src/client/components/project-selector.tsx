import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CaretUpDownIcon } from '@phosphor-icons/react/dist/csr/CaretUpDown';
import { type MouseEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { getProjectSectionPath, getProjectSwitchPath } from '@/client/lib/project-navigation';
import { Badge } from '@/components/ui/badge';
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
  'h-7 w-auto max-w-[18rem] border-0 bg-transparent px-0.5 text-sm font-semibold text-foreground shadow-none focus:ring-0 sm:px-1';

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
  boardCounts,
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
  boardCounts?: { working: number; waiting: number };
  showLeadingSlash?: boolean;
  showTrailingSlash?: boolean;
  trailingSeparatorType?: 'chevron' | 'slash';
}) {
  const countsId = useId();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const selectedProject = projects?.find((project) => project.slug === selectedProjectSlug);
  const selectedProjectName = selectedProject?.name ?? 'Select a project';
  const nameRef = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const name = nameRef.current;
    if (!(name && isMobile && selectedProjectName)) {
      setCompact(false);
      return;
    }
    const measure = () => setCompact(name.scrollWidth > name.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(name);
    return () => observer.disconnect();
  }, [isMobile, selectedProjectName]);
  const { pathname, search } = useLocation();

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

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {showLeadingSlash ? (
        <span className="hidden shrink-0 text-muted-foreground md:inline-flex" aria-hidden>
          <CaretRightIcon className="h-3.5 w-3.5" />
        </span>
      ) : null}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            id={triggerId}
            aria-label="Open project menu"
            aria-describedby={boardCounts ? countsId : undefined}
            title={
              boardCounts
                ? `${selectedProjectName} · Working ${boardCounts.working} · Waiting ${boardCounts.waiting}`
                : selectedProjectName
            }
            className={cn(
              'flex min-w-0 items-center gap-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              DEFAULT_PROJECT_BUTTON_CLASS,
              projectButtonClassName,
              triggerClassName
            )}
          >
            <span className="relative grid min-w-[3em] text-left">
              <span
                ref={nameRef}
                className={cn('col-start-1 row-start-1 truncate', compact && 'invisible')}
              >
                {selectedProjectName}
              </span>
              {compact ? (
                <span className="absolute inset-0 truncate">
                  {getProjectInitials(selectedProjectName)}
                </span>
              ) : null}
            </span>
            {boardCounts ? (
              <span
                id={countsId}
                role="img"
                className="flex shrink-0 gap-1"
                aria-label={`Working ${boardCounts.working} Waiting ${boardCounts.waiting}`}
              >
                <span className="sr-only">
                  Working {boardCounts.working} Waiting {boardCounts.waiting}
                </span>
                <Badge
                  aria-hidden="true"
                  variant="secondary"
                  className="h-5 min-w-5 px-1.5 text-xs tabular-nums"
                >
                  {boardCounts.working}
                </Badge>
                <Badge
                  aria-hidden="true"
                  variant="warning"
                  className="h-5 min-w-5 px-1.5 text-xs tabular-nums"
                >
                  {boardCounts.waiting}
                </Badge>
              </span>
            ) : null}
            <CaretUpDownIcon
              aria-hidden
              className="h-3 w-3 shrink-0 opacity-70 md:h-3.5 md:w-3.5"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
          {projects?.map((project) => {
            const isCurrent = project.slug === selectedProjectSlug;
            const openCurrent = isCurrent && onCurrentProjectSelect;
            return (
              <DropdownMenuItem key={project.id} asChild>
                <Link
                  to={
                    openCurrent
                      ? getProjectSectionPath(project.slug, 'workspaces')
                      : getProjectSwitchPath(project.slug, pathname, search)
                  }
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
