import { ChevronRight, ChevronsUpDown } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const CURRENT_PROJECT_VALUE = '__current_project__';
const DEFAULT_PROJECT_BUTTON_CLASS =
  'h-7 w-auto max-w-[6rem] border-0 bg-transparent px-0.5 text-sm font-semibold text-foreground shadow-none focus:ring-0 sm:max-w-[18rem] sm:px-1 md:max-w-none md:overflow-visible md:text-clip';

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
  showLeadingSlash?: boolean;
  showTrailingSlash?: boolean;
  trailingSeparatorType?: 'chevron' | 'slash';
}) {
  const isMobile = useIsMobile();
  const selectedProject = projects?.find((project) => project.slug === selectedProjectSlug);
  const selectedProjectName = selectedProject?.name ?? 'Select a project';
  const projectButtonLabel =
    isMobile && selectedProject ? getProjectInitials(selectedProject.name) : selectedProjectName;
  const shouldRenderCurrentProjectItem = Boolean(selectedProject && onCurrentProjectSelect);
  const selectableProjects = shouldRenderCurrentProjectItem
    ? projects?.filter((project) => project.slug !== selectedProjectSlug)
    : projects;

  const handleValueChange = (value: string) => {
    if (value === CURRENT_PROJECT_VALUE) {
      onCurrentProjectSelect?.();
      return;
    }
    onProjectChange(value);
  };

  const handleCurrentProjectClick = () => {
    onCurrentProjectSelect?.();
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {showLeadingSlash ? (
        <span className="hidden text-muted-foreground md:inline-flex" aria-hidden>
          <ChevronRight className="h-3.5 w-3.5" />
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
        aria-label={`Open ${selectedProjectName} kanban`}
      >
        {projectButtonLabel}
      </button>
      <Select value={selectedProjectSlug} onValueChange={handleValueChange}>
        <SelectTrigger
          id={triggerId}
          aria-label="Open project menu"
          className={cn(
            'h-7 w-6 shrink-0 border-0 bg-transparent px-0.5 text-muted-foreground shadow-none focus:ring-0 md:w-7 md:px-1 [&>svg:last-of-type]:hidden',
            triggerClassName
          )}
        >
          <span className="sr-only">Open project menu</span>
          <span className="inline-flex items-center text-current" aria-hidden>
            <ChevronsUpDown className="h-3 w-3 opacity-70 md:h-3.5 md:w-3.5" />
          </span>
        </SelectTrigger>
        <SelectContent>
          {shouldRenderCurrentProjectItem && selectedProject ? (
            <SelectItem value={selectedProject.slug} className="hidden" aria-hidden>
              {selectedProject.name}
            </SelectItem>
          ) : null}
          {shouldRenderCurrentProjectItem && selectedProject ? (
            <SelectItem value={CURRENT_PROJECT_VALUE}>{selectedProject.name}</SelectItem>
          ) : null}
          {selectableProjects?.map((project) => (
            <SelectItem key={project.id} value={project.slug}>
              {project.name}
            </SelectItem>
          ))}
          <SelectItem value="__create__" className="text-muted-foreground">
            + Create project
          </SelectItem>
          <SelectItem value="__manage__" className="text-muted-foreground">
            Manage projects...
          </SelectItem>
        </SelectContent>
      </Select>
      {showTrailingSlash ? (
        <span className="-ml-0.5 text-muted-foreground" aria-hidden>
          {trailingSeparatorType === 'slash' ? (
            <span className="text-xs">/</span>
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      ) : null}
    </div>
  );
}
