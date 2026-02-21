import {
  HeaderLeftExtraSlot,
  HeaderRightSlot,
  useAppHeader,
} from '@/frontend/components/app-header-context';
import { KanbanBoard, KanbanControls, KanbanProvider } from '@/frontend/components/kanban';
import { ProjectSelectorDropdown } from '@/frontend/components/project-selector';

function BoardHeaderSlot({
  selectedProjectSlug,
  onProjectChange,
  projects,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
}) {
  useAppHeader({ title: '' });

  return (
    <>
      <HeaderLeftExtraSlot>
        <ProjectSelectorDropdown
          selectedProjectSlug={selectedProjectSlug}
          onProjectChange={onProjectChange}
          projects={projects}
          triggerId="header-project-select"
          triggerClassName="h-7 w-auto max-w-[10rem] gap-1 border-0 bg-transparent px-1 text-xs font-normal text-muted-foreground shadow-none focus:ring-0 sm:max-w-[18rem] sm:text-sm"
        />
      </HeaderLeftExtraSlot>
      <HeaderRightSlot>
        <KanbanControls />
      </HeaderRightSlot>
    </>
  );
}

export function WorkspacesBoardView({
  projectId,
  selectedProjectSlug,
  onProjectChange,
  projects,
  slug,
  issueProvider,
}: {
  projectId: string;
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  slug: string;
  issueProvider: string;
}) {
  return (
    <KanbanProvider projectId={projectId} projectSlug={slug} issueProvider={issueProvider}>
      <BoardHeaderSlot
        selectedProjectSlug={selectedProjectSlug}
        onProjectChange={onProjectChange}
        projects={projects}
      />
      <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
      </div>
    </KanbanProvider>
  );
}
