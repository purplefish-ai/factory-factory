import { HeaderRightSlot, useAppHeader } from '@/frontend/components/app-header-context';
import {
  KanbanBoard,
  KanbanControls,
  KanbanProvider,
  NewWorkspaceHeaderButton,
} from '@/frontend/components/kanban';
import { useIsMobile } from '@/hooks/use-mobile';

function BoardHeaderSlot() {
  useAppHeader({ title: 'Workspaces Board' });
  const isMobile = useIsMobile();

  return (
    <HeaderRightSlot>
      {isMobile && <NewWorkspaceHeaderButton />}
      <KanbanControls />
    </HeaderRightSlot>
  );
}

export function WorkspacesBoardView({
  projectId,
  slug,
  issueProvider,
}: {
  projectId: string;
  slug: string;
  issueProvider: string;
}) {
  return (
    <KanbanProvider projectId={projectId} projectSlug={slug} issueProvider={issueProvider}>
      <BoardHeaderSlot />
      <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
      </div>
    </KanbanProvider>
  );
}
