import type { ReactNode } from 'react';
import { useKanbanActions } from './kanban-context';
import { WorkspaceCreationImageDropZone } from './workspace-creation-image-drop-zone';

export function KanbanImageDropZone({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const { setShowInlineForm } = useKanbanActions();
  return (
    <WorkspaceCreationImageDropZone
      projectId={projectId}
      onDropAccepted={() => setShowInlineForm(true)}
    >
      {children}
    </WorkspaceCreationImageDropZone>
  );
}
