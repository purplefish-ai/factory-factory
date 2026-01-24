'use client';

import type { Task } from '@prisma-gen/browser';
import { TaskState } from '@prisma-gen/browser';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '../../../../frontend/lib/trpc';

const stateColors: Record<string, string> = {
  PLANNING: 'bg-gray-100 text-gray-800',
  PLANNED: 'bg-gray-200 text-gray-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
  ASSIGNED: 'bg-blue-50 text-blue-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  REVIEW: 'bg-purple-100 text-purple-800',
  BLOCKED: 'bg-red-100 text-red-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-200 text-red-900',
  CANCELLED: 'bg-gray-100 text-gray-500',
};

export default function ProjectEpicsPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [stateFilter, setStateFilter] = useState<TaskState | ''>('');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  const { data: topLevelTasks, isLoading } = trpc.task.list.useQuery(
    {
      state: stateFilter ? (stateFilter as TaskState) : undefined,
      isTopLevel: true,
    },
    { enabled: !!project?.id, refetchInterval: 5000 }
  );

  if (isLoading || !project) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading epics...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Epics</h1>
          <p className="text-gray-600 mt-1">{project.name}</p>
        </div>
        <Link
          href={`/projects/${slug}/epics/new`}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Epic
        </Link>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex gap-4 items-center">
          <label className="text-sm font-medium text-gray-700">Filter by state:</label>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as TaskState | '')}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All States</option>
            {Object.values(TaskState).map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Epic List */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {!topLevelTasks || topLevelTasks.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p>No epics found.</p>
            <Link
              href={`/projects/${slug}/epics/new`}
              className="text-blue-600 hover:text-blue-800 mt-2 inline-block"
            >
              Create your first epic
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Title
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tasks
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {topLevelTasks.map((task: Task & { children?: unknown[] }) => (
                <tr key={task.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <Link
                      href={`/projects/${slug}/epics/${task.id}`}
                      className="text-gray-900 font-medium hover:text-blue-600"
                    >
                      {task.title}
                    </Link>
                    {task.description && (
                      <p className="text-sm text-gray-500 truncate max-w-md">
                        {task.description.slice(0, 100)}...
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${stateColors[task.state]}`}
                    >
                      {task.state}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {task.children?.length ?? 0} tasks
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {new Date(task.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      href={`/projects/${slug}/epics/${task.id}`}
                      className="text-blue-600 hover:text-blue-800 text-sm"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
