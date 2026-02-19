import { HeaderRightSlot, useAppHeader } from '@/frontend/components/app-header-context';
import { KanbanBoard, KanbanControls, KanbanProvider } from '@/frontend/components/kanban';
import { NewWorkspaceButton } from './new-workspace-button';

function BoardHeaderSlot({
  onCreateWorkspace,
  isCreatingWorkspace,
}: {
  onCreateWorkspace: () => void;
  isCreatingWorkspace: boolean;
}) {
  useAppHeader({ title: 'Workspaces Board' });

  return (
    <HeaderRightSlot>
      <KanbanControls />
      <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace} />
    </HeaderRightSlot>
  );
}

export function WorkspacesBoardView({
  projectId,
  slug,
  issueProvider,
  onCreateWorkspace,
  isCreatingWorkspace,
}: {
  projectId: string;
  slug: string;
  issueProvider: string;
  onCreateWorkspace: () => void;
  isCreatingWorkspace: boolean;
}) {
  return (
    <KanbanProvider projectId={projectId} projectSlug={slug} issueProvider={issueProvider}>
      <BoardHeaderSlot
        onCreateWorkspace={onCreateWorkspace}
        isCreatingWorkspace={isCreatingWorkspace}
      />
      <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
      </div>
    </KanbanProvider>
  );
}
