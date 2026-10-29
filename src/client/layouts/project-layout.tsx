import { Outlet, useParams } from 'react-router';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

function ProjectLoadError({
  message,
  retry,
  pending,
}: {
  message: string;
  retry: () => void;
  pending: boolean;
}) {
  return (
    <div role="alert" className="space-y-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={retry} disabled={pending}>
        Retry project
      </Button>
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
            message={`Could not refresh project: ${error.message}`}
            retry={retry}
            pending={isFetching}
          />
        ) : null}
        <Outlet />
      </>
    );
  }
  if (isLoading) {
    return (
      <div role="status" className="flex items-center justify-center h-64">
        <span className="sr-only">Loading project…</span>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  return (
    <ProjectLoadError
      message={
        error && !notFound ? `Could not load project: ${error.message}` : 'Project not found'
      }
      retry={retry}
      pending={isFetching}
    />
  );
}
