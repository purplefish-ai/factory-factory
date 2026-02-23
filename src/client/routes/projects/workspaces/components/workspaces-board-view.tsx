import {
  HeaderLeftStartSlot,
  HeaderRightSlot,
  useAppHeader,
} from '@/client/components/app-header-context';
import { KanbanBoard, KanbanControls, KanbanProvider } from '@/client/components/kanban';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';

function BoardHeaderSlot({
  selectedProjectSlug,
  onProjectChange,
  onCurrentProjectSelect,
  projects,
}: {
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  onCurrentProjectSelect: () => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
}) {
  useAppHeader({ title: '' });

  return (
    <>
      <HeaderLeftStartSlot>
        <ProjectSelectorDropdown
          selectedProjectSlug={selectedProjectSlug}
          onProjectChange={onProjectChange}
          onCurrentProjectSelect={onCurrentProjectSelect}
          projects={projects}
          triggerId="header-project-select"
          projectButtonClassName="h-7 w-auto max-w-[10rem] gap-1 border-0 bg-transparent px-1 text-xs font-normal text-muted-foreground shadow-none focus:ring-0 sm:max-w-[18rem] sm:text-sm"
        />
      </HeaderLeftStartSlot>
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
  onCurrentProjectSelect,
  projects,
  slug,
  issueProvider,
}: {
  projectId: string;
  selectedProjectSlug: string;
  onProjectChange: (value: string) => void;
  onCurrentProjectSelect: () => void;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  slug: string;
  issueProvider: string;
}) {
  return (
    <KanbanProvider projectId={projectId} projectSlug={slug} issueProvider={issueProvider}>
      <BoardHeaderSlot
        selectedProjectSlug={selectedProjectSlug}
        onProjectChange={onProjectChange}
        onCurrentProjectSelect={onCurrentProjectSelect}
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
