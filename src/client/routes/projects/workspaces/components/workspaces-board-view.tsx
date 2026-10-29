import { HeaderRightSlot } from '@/client/components/app-header-context';
import { ProjectSectionHeader } from '@/client/components/project-section-header';
import { KanbanBoard, KanbanControls, KanbanProvider } from '@/client/features/kanban';
import type { IssueProvider } from '@/shared/core';

function BoardHeaderSlot({ project }: { project: { id: string; slug: string; name: string } }) {
  return (
    <>
      <ProjectSectionHeader project={project} />
      <HeaderRightSlot>
        <KanbanControls />
      </HeaderRightSlot>
    </>
  );
}

export function WorkspacesBoardView({
  projectId,
  projects,
  projectName,
  slug,
  issueProvider,
}: {
  projectId: string;
  projectName?: string;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  slug: string;
  issueProvider: IssueProvider;
}) {
  return (
    <KanbanProvider
      key={projectId}
      projectId={projectId}
      projectSlug={slug}
      issueProvider={issueProvider}
    >
      <BoardHeaderSlot
        project={
          projects?.find((candidate) => candidate.id === projectId) ?? {
            id: projectId,
            slug,
            name: projectName ?? slug,
          }
        }
      />
      <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
        <div className="flex-1 min-h-0">
          <KanbanBoard />
        </div>
      </div>
    </KanbanProvider>
  );
}
