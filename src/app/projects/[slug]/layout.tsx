'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const {
    data: project,
    isLoading,
    error,
  } = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });

  useEffect(() => {
    if (!(isLoading || project || error)) {
      // Project not found, redirect to projects list
      router.push('/projects');
    }
  }, [isLoading, project, error, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Project not found</p>
      </div>
    );
  }

  return <>{children}</>;
}
