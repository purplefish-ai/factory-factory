'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

// Redirect old /mail/[id] route to project-scoped route
export default function MailDetailRedirect() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: projects, isLoading } = trpc.project.list.useQuery({ isArchived: false });

  useEffect(() => {
    if (!isLoading && projects) {
      if (projects.length > 0) {
        // Get stored project or use first one
        const stored = localStorage.getItem('factoryfactory_selected_project_slug');
        const slug = stored || projects[0].slug;
        router.replace(`/projects/${slug}/mail/${id}`);
      } else {
        router.replace('/projects/new');
      }
    }
  }, [isLoading, projects, id, router]);

  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-pulse text-gray-500">Redirecting...</div>
    </div>
  );
}
