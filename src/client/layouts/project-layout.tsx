import { useEffect } from 'react';
import { Outlet, useParams } from 'react-router';
import { useProjectContext } from '@/frontend/lib/providers';
import { trpc } from '@/frontend/lib/trpc';

export function ProjectLayout() {
  const { slug = '' } = useParams<{ slug: string }>();
  const { setProjectContext } = useProjectContext();

  const {
    data: project,
    isLoading,
    error,
  } = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });

  // Set project context for tRPC requests when project is loaded
  useEffect(() => {
    if (project?.id) {
      setProjectContext(project.id);
    }
    return () => {
      // Clear project context when leaving project pages
      setProjectContext(undefined);
    };
  }, [project?.id, setProjectContext]);

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
