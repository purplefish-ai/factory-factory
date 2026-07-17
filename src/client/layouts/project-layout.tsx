import { Outlet, useParams } from 'react-router';
import { trpc } from '@/client/lib/trpc';

export function ProjectLayout() {
  const { slug = '' } = useParams<{ slug: string }>();

  const {
    data: project,
    isLoading,
    error,
  } = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Project not found</p>
      </div>
    );
  }

  return <Outlet />;
}
