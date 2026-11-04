import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Loading } from '@/client/components/loading';
import { readSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';

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
      void navigate('/projects', { replace: true });
      return;
    }

    if (projects && projects.length > 0) {
      // Get stored project or use first one
      const stored = readSelectedProjectSlug();
      const slug = stored || projects[0]?.slug;
      if (!slug) {
        return;
      }
      void navigate(`/projects/${slug}`, { replace: true });
    } else {
      void navigate('/projects/new', { replace: true });
    }
  }, [isLoading, projects, error, navigate]);

  // An error redirects to the projects page, which shows it with Retry.
  return <Loading message={error ? 'Opening projects…' : 'Loading projects…'} />;
}
