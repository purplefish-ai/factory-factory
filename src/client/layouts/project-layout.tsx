import { Link, Outlet, useParams } from 'react-router';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { isNotFoundError } from '@/client/components/query-state';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

export function ProjectLayout() {
  const { slug = '' } = useParams<{ slug: string }>();
  const {
    data: project,
    isFetching,
    error,
    refetch,
  } = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });
  const retry = () => {
    void refetch();
  };
  const notFound = isNotFoundError(error);

  // Recoverable background failures must not unmount owned editors and drafts.
  // Also reject data for another slug rather than keeping a previous owner alive.
  if (project?.slug === slug && !notFound) {
    return (
      <>
        {error ? (
          <QueryRefreshError
            title="Couldn't refresh project"
            error={error}
            onRetry={retry}
            isRetrying={isFetching}
          />
        ) : null}
        <Outlet />
      </>
    );
  }
  // Paused and disabled queries can be unresolved without actively fetching.
  if (!error) {
    return <Loading message="Loading project…" className="h-64" />;
  }
  if (notFound) {
    return (
      <EmptyState
        title="Project not found"
        action={
          <Button variant="outline" asChild>
            <Link to="/projects">Go to projects</Link>
          </Button>
        }
      />
    );
  }
  return (
    <QueryErrorState
      title="Couldn't load project"
      error={error}
      onRetry={retry}
      isRetrying={isFetching}
    />
  );
}
