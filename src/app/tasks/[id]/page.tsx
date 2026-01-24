'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

// Redirect old /tasks/[id] route to project-scoped route
export default function TaskDetailRedirect() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: task, isLoading } = trpc.task.getById.useQuery({ id });

  useEffect(() => {
    if (!isLoading && task) {
      router.replace(`/projects/${task.epic.project.slug}/tasks/${id}`);
    }
  }, [isLoading, task, id, router]);

  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-pulse text-gray-500">Redirecting...</div>
    </div>
  );
}
