import { useMemo } from 'react';
import { HeaderRightSlot, useAppHeader } from '@/frontend/components/app-header-context';
import { KanbanBoard, KanbanControls, KanbanProvider } from '@/frontend/components/kanban';

function BoardHeaderSlot({ projectName }: { projectName: string }) {
  const title = useMemo(
    () => (
      <>
        Workspaces <span className="font-normal text-muted-foreground">· {projectName}</span>
      </>
    ),
    [projectName]
  );

  useAppHeader({ title });

  return (
    <HeaderRightSlot>
      <KanbanControls />
    </HeaderRightSlot>
  );
}

export function WorkspacesBoardView({
  projectId,
  projectName,
  slug,
  issueProvider,
}: {
  projectId: string;
  projectName: string;
  slug: string;
  issueProvider: string;
}) {
  return (
    <KanbanProvider projectId={projectId} projectSlug={slug} issueProvider={issueProvider}>
      <BoardHeaderSlot projectName={projectName} />
      <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
      </div>
    </KanbanProvider>
  );
}
