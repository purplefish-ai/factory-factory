import { Loading } from '@/client/components/loading';
import { ALL_PROJECTS_SLUG } from '@/client/components/project-selector';
import { trpc } from '@/client/lib/trpc';
import { AllProjectsBoardView, WorkspacesBoardView } from './components';
import { useWorkspaceProjectNavigation } from './use-workspace-project-navigation';

export default function WorkspacesListPage() {
  const { slug, projects, handleProjectChange, handleCurrentProjectSelect } =
    useWorkspaceProjectNavigation();

  const isAllProjects = slug === ALL_PROJECTS_SLUG;

  const { data: project } = trpc.project.getBySlug.useQuery({ slug }, { enabled: !isAllProjects });

  if (isAllProjects) {
    return (
      <AllProjectsBoardView
        selectedProjectSlug={slug}
        onProjectChange={handleProjectChange}
        projects={projects}
      />
    );
  }

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
