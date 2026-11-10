import { useEffect } from 'react';
import { HeaderRightSlot } from '@/client/components/app-header-context';
import { ProjectHeader } from '@/client/components/project-header';
import {
  KanbanBoard,
  KanbanControls,
  KanbanImageDropZone,
  KanbanProvider,
  useKanbanActions,
} from '@/client/features/kanban';
import type { IssueProvider } from '@/shared/core';

function BoardHeaderSlot({ project }: { project: { id: string; slug: string; name: string } }) {
  return (
    <>
      <ProjectHeader project={project} />
      <HeaderRightSlot>
        <KanbanControls />
      </HeaderRightSlot>
    </>
  );
}

/** Opens the inline form for a URL request (e.g. the retired `/workspaces/new` route). */
function OpenNewWorkspaceFormRequest({ onOpened }: { onOpened?: () => void }) {
  const { requestInlineForm } = useKanbanActions();
  useEffect(() => {
    requestInlineForm();
    onOpened?.();
  }, [requestInlineForm, onOpened]);
  return null;
}

export function WorkspacesBoardView({
  projectId,
  projects,
  projectName,
  slug,
  issueProvider,
  openNewWorkspaceForm = false,
  onNewWorkspaceFormOpened,
}: {
  projectId: string;
  projectName?: string;
  projects: Array<{ id: string; slug: string; name: string }> | undefined;
  slug: string;
  issueProvider: IssueProvider;
  openNewWorkspaceForm?: boolean;
  onNewWorkspaceFormOpened?: () => void;
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
      {openNewWorkspaceForm ? (
        <OpenNewWorkspaceFormRequest onOpened={onNewWorkspaceFormOpened} />
      ) : null}
      <KanbanImageDropZone projectId={projectId}>
        <div className="flex flex-col h-full p-3 md:p-6 gap-3 md:gap-4">
          <div className="flex-1 min-h-0">
            <KanbanBoard />
          </div>
        </div>
      </KanbanImageDropZone>
    </KanbanProvider>
  );
}
