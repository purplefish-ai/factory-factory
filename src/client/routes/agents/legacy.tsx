import { Navigate, useLocation, useParams } from 'react-router';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { QueryErrorState } from '@/client/components/query-error-state';
import { isNotFoundError } from '@/client/components/query-state';
import { useAppNavigationDataContext } from '@/client/hooks/use-app-navigation-data';
import {
  getAgentRouteKind,
  getProjectAgentPath,
  getProjectSectionPath,
} from '@/client/lib/project-navigation';
import { resolveSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';

function LegacyAgentDetail({ id }: { id: string }) {
  const navigation = useAppNavigationDataContext();
  const task = trpc.periodicTask.get.useQuery({ id });
  const listedOwner = navigation.projects?.find((project) => project.id === task.data?.projectId);
  const owner = trpc.project.getById.useQuery(
    { id: task.data?.projectId ?? '' },
    { enabled: !!task.data && !listedOwner }
  );
  if (isNotFoundError(task.error)) {
    return (
      <EmptyState
        title="Automation not found"
        description="This automation is no longer available."
        className="h-full"
      />
    );
  }
  if (task.error) {
    return (
      <QueryErrorState
        title="Couldn't load automation"
        error={task.error}
        onRetry={() => {
          void task.refetch();
        }}
        isRetrying={task.isFetching}
        className="h-full"
      />
    );
  }
  if (owner.error && !listedOwner) {
    return (
      <QueryErrorState
        title="Couldn't load automation project"
        error={owner.error}
        onRetry={() => {
          void owner.refetch();
        }}
        isRetrying={owner.isFetching}
        className="h-full"
      />
    );
  }
  const project = listedOwner ?? owner.data;
  return project ? (
    <Navigate replace to={getProjectAgentPath(project.slug, id)} />
  ) : (
    <Loading message="Loading automation project…" />
  );
}
function LegacyAgentsIndex() {
  const navigation = useAppNavigationDataContext();
  // Cached projects still resolve the redirect when only a refresh failed.
  if (navigation.projectsError && !navigation.projects) {
    return (
      <QueryErrorState
        title="Couldn't load projects"
        error={navigation.projectsError}
        onRetry={() => {
          void navigation.refetchProjects();
        }}
        className="h-full"
      />
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
        Event-triggered automation links require an explicit project owner and a valid kind.
      </p>
    );
  }
  return id ? <LegacyAgentDetail key={id} id={id} /> : <LegacyAgentsIndex />;
}
