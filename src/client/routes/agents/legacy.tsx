import { Navigate, useLocation, useParams } from 'react-router';
import { Loading } from '@/client/components/loading';
import { useAppNavigationDataContext } from '@/client/hooks/use-app-navigation-data';
import {
  getAgentRouteKind,
  getProjectAgentPath,
  getProjectSectionPath,
} from '@/client/lib/project-navigation';
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
            : `Couldn't load agent. ${task.error.message}`}
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
        <p>Couldn't load agent project. {owner.error.message}</p>
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
    <Loading message="Loading agent project…" />
  );
}
function LegacyAgentsIndex() {
  const navigation = useAppNavigationDataContext();
  if (navigation.projectsError) {
    return (
      <div role="alert" className="space-y-3 p-6">
        <p>Couldn't load projects. {navigation.projectsError.message}</p>
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
    return <Loading message="Loading projects…" />;
  }
  const slug = resolveSelectedProjectSlug(navigation.projects);
  return <Navigate replace to={slug ? getProjectSectionPath(slug, 'agents') : '/projects/new'} />;
}
/** Resolve old global links before mounting any project management UI. */
export default function LegacyAgentsRoute() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const kind = getAgentRouteKind(location.search);
  if (!kind || kind === 'event') {
    return (
      <p role="alert" className="p-6">
        Event agent links require an explicit project owner and a valid kind.
      </p>
    );
  }
  return id ? <LegacyAgentDetail key={id} id={id} /> : <LegacyAgentsIndex />;
}
