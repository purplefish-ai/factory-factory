import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ProjectSettingsSection, type SettingsProject } from './ProjectSettingsSection';

export function ProjectSettingsRow({
  project,
  open,
  onOpenChange,
}: {
  project: SettingsProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remember the first expansion in the render that opens the row.
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) {
    setHasOpened(true);
  }
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <li>
        <h2>
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-md px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-muted focus-ring">
            <span className="min-w-0 break-words">{project.name}</span>
            <CaretRightIcon
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent forceMount hidden={!open} className="min-w-0 space-y-4 p-3 pt-0">
          {/* Mount on first expansion, then preserve unsaved editor state while hidden. */}
          {hasOpened ? <ProjectSettingsSection project={project} /> : null}
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}
