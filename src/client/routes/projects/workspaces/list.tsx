import { useParams } from 'react-router';
import { Loading } from '@/frontend/components/loading';
import { useCreateWorkspace } from '@/frontend/hooks/use-create-workspace';
import { trpc } from '@/frontend/lib/trpc';
import { WorkspacesBoardView } from './components';

export default function WorkspacesListPage() {
  const { slug = '' } = useParams<{ slug: string }>();

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });
  const { handleCreate: createWorkspace, isCreating } = useCreateWorkspace(project?.id, slug);

  // Swallow the re-thrown error — toast is already shown by the hook
  const handleCreate = () => {
    createWorkspace().catch(() => {
      // Error already handled (toast shown) by the hook
    });
  };

  if (!project) {
    return <Loading message="Loading project..." />;
  }

  return (
    <WorkspacesBoardView
      projectId={project.id}
      slug={slug}
      issueProvider={project.issueProvider}
      onCreateWorkspace={handleCreate}
      isCreatingWorkspace={isCreating}
    />
  );
}
