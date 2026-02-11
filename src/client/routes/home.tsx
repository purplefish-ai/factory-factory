import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { trpc } from '@/frontend/lib/trpc';

// Redirect root to project-scoped page
export default function HomePage() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = trpc.project.list.useQuery({ isArchived: false });

  useEffect(() => {
    if (isLoading) {
      return;
    }

    // On error, redirect to projects page where error can be shown properly
    if (error) {
      navigate('/projects', { replace: true });
      return;
    }

    if (projects && projects.length > 0) {
      // Get stored project or use first one
      const stored = localStorage.getItem('factoryfactory_selected_project_slug');
      const slug = stored || projects[0]?.slug;
      if (!slug) {
        return;
      }
      navigate(`/projects/${slug}`, { replace: true });
    } else {
      navigate('/projects/new', { replace: true });
    }
  }, [isLoading, projects, error, navigate]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-destructive">Error loading projects. Redirecting...</div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}
