import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const CURRENT_PROJECT_VALUE = '__current_project__';

export function ProjectSelectorDropdown({
  selectedProjectSlug,
  onProjectChange,
  projects,
  triggerClassName,
  projectButtonClassName,
  triggerId = 'project-select',
  onCurrentProjectSelect,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  triggerClassName?: string;
  projectButtonClassName?: string;
  triggerId?: string;
  onCurrentProjectSelect?: () => void;
}) {
  const selectedProject = projects?.find((project) => project.slug === selectedProjectSlug);
  const selectedProjectName = selectedProject?.name ?? 'Select a project';
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
      <button
        type="button"
        onClick={handleCurrentProjectClick}
        disabled={!onCurrentProjectSelect}
        className={cn(
          'min-w-0 truncate text-left',
          onCurrentProjectSelect
            ? 'cursor-pointer hover:text-foreground focus-visible:text-foreground'
            : 'cursor-default',
          projectButtonClassName
        )}
        aria-label={`Open ${selectedProjectName} kanban`}
      >
        {selectedProjectName}
      </button>
      <Select value={selectedProjectSlug} onValueChange={handleValueChange}>
        <SelectTrigger
          id={triggerId}
          aria-label="Open project menu"
          className={cn(
            'h-7 w-7 shrink-0 border-0 bg-transparent px-1 text-muted-foreground shadow-none focus:ring-0',
            triggerClassName
          )}
        >
          <span className="sr-only">Open project menu</span>
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
    </div>
  );
}
