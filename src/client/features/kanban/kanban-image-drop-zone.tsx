import type { ReactNode } from 'react';
import { useKanban } from './kanban-context';
import { WorkspaceCreationImageDropZone } from './workspace-creation-image-drop-zone';

export function KanbanImageDropZone({ children }: { children: ReactNode }) {
  const { projectId, setShowInlineForm } = useKanban();
  return (
    <WorkspaceCreationImageDropZone
      projectId={projectId}
      onDropAccepted={() => setShowInlineForm(true)}
    >
      {children}
    </WorkspaceCreationImageDropZone>
  );
}
