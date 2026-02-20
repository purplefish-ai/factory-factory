import { useParams } from 'react-router';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';
import { WorkspacesBoardView } from './components';

export default function WorkspacesListPage() {
  const { slug = '' } = useParams<{ slug: string }>();

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  if (!project) {
    return <Loading message="Loading project..." />;
  }

  return (
    <WorkspacesBoardView
      projectId={project.id}
      projectName={project.name}
      slug={slug}
      issueProvider={project.issueProvider}
    />
  );
}
