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
    isLoading,
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
  if (isLoading) {
    return <Loading message="Loading project…" className="h-64" />;
  }
  return (
    <ProjectLoadError
      message={error && !notFound ? `Couldn't load project. ${error.message}` : 'Project not found'}
      retry={retry}
      pending={isFetching}
      notFound={notFound || !error}
    />
  );
}
