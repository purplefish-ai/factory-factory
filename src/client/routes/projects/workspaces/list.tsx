import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '@/frontend/lib/trpc';
import { WorkspacesBoardView } from './components';

export default function WorkspacesListPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });
  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });

  const handleProjectChange = useCallback(
    (value: string) => {
      if (value === '__manage__') {
        void navigate('/projects');
        return;
      }
      if (value === '__create__') {
        void navigate('/projects/new');
        return;
      }
      void navigate(`/projects/${value}/workspaces`);
    },
    [navigate]
  );

  if (!project) {
    return <Loading message="Loading project..." />;
  }

  return (
    <WorkspacesBoardView
      projectId={project.id}
      selectedProjectSlug={slug}
      onProjectChange={handleProjectChange}
      projects={projects}
      slug={slug}
      issueProvider={project.issueProvider}
    />
  );
}
