import { Navigate, useParams } from 'react-router';
import { useAppNavigationDataContext } from '@/client/hooks/use-app-navigation-data';
import { getProjectAgentPath, getProjectSectionPath } from '@/client/lib/project-navigation';
import { resolveSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

function LegacyAgentDetail({ id }: { id: string }) {
  const navigation = useAppNavigationDataContext();
  const task = trpc.periodicTask.get.useQuery({ id }, { retry: false });
  const listedOwner = navigation.projects?.find((project) => project.id === task.data?.projectId);
  const owner = trpc.project.getById.useQuery(
    { id: task.data?.projectId ?? '' },
    { enabled: !!task.data && !listedOwner, retry: false }
  );
  if (task.error) {
    return (
      <div role="alert" className="space-y-3 p-6">
        <p>
          {task.error.data?.code === 'NOT_FOUND'
            ? 'Agent not found. This agent is no longer available.'
            : `Could not load agent: ${task.error.message}`}
        </p>
        <Button
          onClick={() => {
            void task.refetch();
          }}
        >
          Retry agent
        </Button>
      </div>
    );
  }
  if (owner.error && !listedOwner) {
    return (
      <div role="alert" className="space-y-3 p-6">
        <p>Could not load agent project: {owner.error.message}</p>
        <Button
          onClick={() => {
            void owner.refetch();
          }}
        >
          Retry project
        </Button>
      </div>
    );
  }
  const project = listedOwner ?? owner.data;
  return project ? (
    <Navigate replace to={getProjectAgentPath(project.slug, id)} />
  ) : (
    <p role="status" className="p-6">
      Loading agent project…
    </p>
  );
}
function LegacyAgentsIndex() {
  const navigation = useAppNavigationDataContext();
  if (navigation.projectsError) {
    return (
      <div role="alert" className="space-y-3 p-6">
        <p>Could not load projects: {navigation.projectsError.message}</p>
        <Button
          onClick={() => {
            void navigation.refetchProjects();
          }}
        >
          Retry projects
        </Button>
      </div>
    );
  }
  if (!navigation.projects) {
    return (
      <p role="status" className="p-6">
        Loading projects…
      </p>
    );
  }
  const slug = resolveSelectedProjectSlug(navigation.projects);
  return <Navigate replace to={slug ? getProjectSectionPath(slug, 'agents') : '/projects/new'} />;
}
/** Resolve old global links before mounting any project management UI. */
export default function LegacyAgentsRoute() {
  const { id } = useParams<{ id: string }>();
  return id ? <LegacyAgentDetail key={id} id={id} /> : <LegacyAgentsIndex />;
}
