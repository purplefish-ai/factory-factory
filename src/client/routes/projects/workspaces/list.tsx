import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { WorkspacesBoardView } from './components';
import { useWorkspaceProjectNavigation } from './use-workspace-project-navigation';

export default function WorkspacesListPage() {
  const { slug, projects, handleProjectChange, handleCurrentProjectSelect } =
    useWorkspaceProjectNavigation();

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  if (!project) {
    return <Loading message="Loading project..." />;
  }

  return (
    <WorkspacesBoardView
      projectId={project.id}
      selectedProjectSlug={slug}
      onProjectChange={handleProjectChange}
      onCurrentProjectSelect={handleCurrentProjectSelect}
      projects={projects}
      slug={slug}
      issueProvider={project.issueProvider}
    />
  );
}
