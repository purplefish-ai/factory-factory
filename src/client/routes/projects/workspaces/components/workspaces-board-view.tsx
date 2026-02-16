import { KanbanBoard, KanbanControls, KanbanProvider } from '@/frontend/components/kanban';
import { PageHeader } from '@/frontend/components/page-header';
import { NewWorkspaceButton } from './new-workspace-button';
import { ResumeBranchButton } from './resume-branch-button';
import type { ViewMode } from './types';
import { ViewModeToggle } from './view-mode-toggle';

export function WorkspacesBoardView({
  projectId,
  slug,
  viewMode,
  onViewModeChange,
  onResumeOpen,
  onCreateWorkspace,
  isCreatingWorkspace,
  resumeDialog,
}: {
  projectId: string;
  slug: string;
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  onResumeOpen: () => void;
  onCreateWorkspace: () => void;
  isCreatingWorkspace: boolean;
  resumeDialog: React.ReactNode;
}) {
  return (
    <KanbanProvider projectId={projectId} projectSlug={slug}>
      <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
        <PageHeader title="Workspaces">
          <KanbanControls />
          <ViewModeToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
          <ResumeBranchButton onClick={onResumeOpen} />
          <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace}>
            Workspace
          </NewWorkspaceButton>
        </PageHeader>

        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
        {resumeDialog}
      </div>
    </KanbanProvider>
  );
}
