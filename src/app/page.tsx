'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { trpc } from '../frontend/lib/trpc';

// Redirect root to project-scoped epics page
export default function RootRedirect() {
  const router = useRouter();
  const { data: projects, isLoading, error } = trpc.project.list.useQuery({ isArchived: false });

  useEffect(() => {
    if (isLoading) return;

    // On error, redirect to projects page where error can be shown properly
    if (error) {
      router.replace('/projects');
      return;
    }

    if (projects && projects.length > 0) {
      // Get stored project or use first one
      const stored = localStorage.getItem('factoryfactory_selected_project_slug');
      const slug = stored || projects[0].slug;
      router.replace(`/projects/${slug}/epics`);
    } else {
      router.replace('/projects/new');
    }
  }, [isLoading, projects, error, router]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-500">Error loading projects. Redirecting...</div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-pulse text-gray-500">Loading...</div>
    </div>
  );
}
