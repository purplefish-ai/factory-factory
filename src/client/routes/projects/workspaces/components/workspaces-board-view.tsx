import { GitBranch, Kanban, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { KanbanBoard, KanbanControls, KanbanProvider } from '@/frontend/components/kanban';
import { PageHeader } from '@/frontend/components/page-header';
import { NewWorkspaceButton } from './new-workspace-button';

type ViewMode = 'list' | 'board';

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
      <div className="flex flex-col h-screen p-6 gap-4">
        <PageHeader title="Workspaces">
          <KanbanControls />
          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(value) => value && onViewModeChange(value as ViewMode)}
            size="sm"
          >
            <ToggleGroupItem value="board" aria-label="Board view">
              <Kanban className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List view">
              <List className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" size="sm" onClick={onResumeOpen}>
            <GitBranch className="h-4 w-4 mr-2" />
            Resume branch
          </Button>
          <NewWorkspaceButton onClick={onCreateWorkspace} isCreating={isCreatingWorkspace} />
        </PageHeader>

        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
        {resumeDialog}
      </div>
    </KanbanProvider>
  );
}
