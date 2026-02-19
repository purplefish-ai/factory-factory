import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function ProjectSelectorDropdown({
  selectedProjectSlug,
  onProjectChange,
  projects,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
}) {
  return (
    <Select value={selectedProjectSlug} onValueChange={onProjectChange}>
      <SelectTrigger id="project-select" className="w-fit max-w-full px-4 gap-3">
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
