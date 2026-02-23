import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const CURRENT_PROJECT_VALUE = '__current_project__';

export function ProjectSelectorDropdown({
  selectedProjectSlug,
  onProjectChange,
  projects,
  triggerClassName,
  triggerId = 'project-select',
  onCurrentProjectSelect,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  triggerClassName?: string;
  triggerId?: string;
  onCurrentProjectSelect?: () => void;
}) {
  const selectedProject = projects?.find((project) => project.slug === selectedProjectSlug);
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

  return (
    <Select value={selectedProjectSlug} onValueChange={handleValueChange}>
      <SelectTrigger
        id={triggerId}
        className={cn('w-full max-w-full gap-3 px-4', triggerClassName)}
      >
        <SelectValue placeholder="Select a project" />
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
  );
}
