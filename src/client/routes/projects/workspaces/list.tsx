import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { Loading } from '@/client/components/loading';
import { NEW_WORKSPACE_SEARCH_PARAM } from '@/client/lib/project-navigation';
import { trpc } from '@/client/lib/trpc';
import { WorkspacesBoardView } from './components';
import { useWorkspaceProjectNavigation } from './use-workspace-project-navigation';

export default function WorkspacesListPage() {
  const { slug, projects } = useWorkspaceProjectNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const openNewWorkspaceForm = searchParams.has(NEW_WORKSPACE_SEARCH_PARAM);
  // Consume the one-shot request so a refresh or Back does not reopen the form.
  const handleNewWorkspaceFormOpened = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(NEW_WORKSPACE_SEARCH_PARAM);
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  if (!project) {
    return <Loading message="Loading project..." />;
  }

  return (
    <WorkspacesBoardView
      projectId={project.id}
      projectName={project.name}
      projects={projects}
      slug={slug}
      issueProvider={project.issueProvider}
      openNewWorkspaceForm={openNewWorkspaceForm}
      onNewWorkspaceFormOpened={handleNewWorkspaceFormOpened}
    />
  );
}
