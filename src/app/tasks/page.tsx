'use client';

import Link from 'next/link';
import { trpc } from '../../frontend/lib/trpc';
import { TaskState } from '../../lib/prisma-enums';
import { useState } from 'react';

const stateColors: Record<string, string> = {
  PENDING: 'bg-gray-100 text-gray-800',
  ASSIGNED: 'bg-yellow-100 text-yellow-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  REVIEW: 'bg-purple-100 text-purple-800',
  BLOCKED: 'bg-red-100 text-red-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
};

export default function TasksPage() {
  const [stateFilter, setStateFilter] = useState<TaskState | ''>('');

  const { data: tasks, isLoading } = trpc.task.list.useQuery(
    stateFilter ? { state: stateFilter as TaskState } : undefined,
    { refetchInterval: 5000 }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading tasks...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Tasks</h1>
        <p className="text-gray-600 mt-1">View and monitor task progress</p>
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

      {/* Task List */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {!tasks || tasks.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p>No tasks found.</p>
            <p className="text-sm mt-2">Tasks are created automatically when epics are processed.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Title
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Epic
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Worker
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  PR
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {tasks.map((task) => (
                <tr key={task.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <Link
                      href={`/tasks/${task.id}`}
                      className="text-gray-900 font-medium hover:text-blue-600"
                    >
                      {task.title}
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    {(task as { epic?: { title: string } }).epic && (
                      <Link
                        href={`/epics/${task.epicId}`}
                        className="text-sm text-blue-600 hover:text-blue-800"
                      >
                        {(task as { epic?: { title: string } }).epic?.title.slice(0, 30)}...
                      </Link>
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
                    {task.assignedAgentId ? (
                      <Link
                        href={`/agents/${task.assignedAgentId}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        View Worker
                      </Link>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {task.prUrl ? (
                      <a
                        href={task.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800"
                      >
                        View PR
                      </a>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      href={`/tasks/${task.id}`}
                      className="text-blue-600 hover:text-blue-800 text-sm"
                    >
                      Details
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
