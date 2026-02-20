import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export function ProjectSelectorDropdown({
  selectedProjectSlug,
  onProjectChange,
  projects,
  triggerClassName,
  triggerId = 'project-select',
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  triggerClassName?: string;
  triggerId?: string;
}) {
  return (
    <Select value={selectedProjectSlug} onValueChange={onProjectChange}>
      <SelectTrigger
        id={triggerId}
        className={cn('w-full max-w-full gap-3 px-4', triggerClassName)}
      >
        <SelectValue placeholder="Select a project" />
      </SelectTrigger>
      <SelectContent>
        {projects?.map((project) => (
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
