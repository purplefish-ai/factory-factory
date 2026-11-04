import { Link, Outlet, useParams } from 'react-router';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

function ProjectLoadError({
  message,
  retry,
  pending,
  notFound = false,
}: {
  message: string;
  retry: () => void;
  pending: boolean;
  notFound?: boolean;
}) {
  return (
    <div role="alert" className="space-y-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      {notFound ? (
        <Button variant="outline" asChild>
          <Link to="/projects">Go to projects</Link>
        </Button>
      ) : (
        <Button variant="outline" onClick={retry} disabled={pending}>
          Retry project
        </Button>
      )}
    </div>
  );
}

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
  const notFound = error?.data?.code === 'NOT_FOUND';

  // Recoverable background failures must not unmount owned editors and drafts.
  // Also reject data for another slug rather than keeping a previous owner alive.
  if (project?.slug === slug && !notFound) {
    return (
      <>
        {error ? (
          <ProjectLoadError
            message={`Couldn't refresh project. ${error.message}`}
            retry={retry}
            pending={isFetching}
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
  return (
    <ProjectLoadError
      message={notFound ? 'Project not found' : `Couldn't load project. ${error.message}`}
      retry={retry}
      pending={isFetching}
      notFound={notFound}
    />
  );
}
