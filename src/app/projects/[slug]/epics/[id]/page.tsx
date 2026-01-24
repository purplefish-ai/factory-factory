'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { trpc } from '../../../../../frontend/lib/trpc';

const stateColors: Record<string, string> = {
  PLANNING: 'bg-gray-100 text-gray-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  BLOCKED: 'bg-red-100 text-red-800',
  COMPLETED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-gray-100 text-gray-500',
};

const taskStateColors: Record<string, string> = {
  PENDING: 'bg-gray-100 text-gray-800',
  ASSIGNED: 'bg-yellow-100 text-yellow-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  REVIEW: 'bg-purple-100 text-purple-800',
  BLOCKED: 'bg-red-100 text-red-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
};

export default function EpicDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const id = params.id as string;

  const {
    data: topLevelTask,
    isLoading,
    error,
  } = trpc.task.getById.useQuery({ id }, { refetchInterval: 5000 });

  const { data: childTasks } = trpc.task.listByParent.useQuery(
    { parentId: id },
    { refetchInterval: 5000 }
  );

  const { data: agents } = trpc.agent.listByTopLevelTask.useQuery(
    { topLevelTaskId: id },
    { refetchInterval: 2000 }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading epic...</div>
      </div>
    );
  }

  if (error || !topLevelTask) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-red-600 mb-4">Epic not found</p>
        <Link href={`/projects/${slug}/epics`} className="text-blue-600 hover:text-blue-800">
          Back to epics
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/projects/${slug}/epics`} className="text-gray-500 hover:text-gray-700">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{topLevelTask.title}</h1>
            <div className="flex items-center gap-3 mt-2">
              <span
                className={`px-2 py-1 rounded text-xs font-medium ${stateColors[topLevelTask.state]}`}
              >
                {topLevelTask.state}
              </span>
              <span className="text-sm text-gray-500">
                Created {new Date(topLevelTask.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
        {topLevelTask.linearIssueUrl && (
          <a
            href={topLevelTask.linearIssueUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 text-sm"
          >
            View in Linear
          </a>
        )}
      </div>

      {/* Description */}
      {topLevelTask.description && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-3">Description</h2>
          <div className="prose prose-sm max-w-none">
            <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">
              {topLevelTask.description}
            </pre>
          </div>
        </div>
      )}

      {/* Supervisor Info */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-semibold mb-3">Supervisor Agent</h2>
        {agents?.find((a) => a.type === 'SUPERVISOR') ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">
                Agent ID:{' '}
                <span className="font-mono">{agents.find((a) => a.type === 'SUPERVISOR')?.id}</span>
              </p>
              <p className="text-sm text-gray-600">
                State: {agents.find((a) => a.type === 'SUPERVISOR')?.state}
              </p>
            </div>
            {agents.find((a) => a.type === 'SUPERVISOR')?.tmuxSessionName && (
              <Link
                href={`/projects/${slug}/agents/${agents.find((a) => a.type === 'SUPERVISOR')?.id}`}
                className="text-blue-600 hover:text-blue-800 text-sm"
              >
                View Terminal
              </Link>
            )}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No supervisor assigned yet</p>
        )}
      </div>

      {/* Tasks */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Tasks ({childTasks?.length ?? 0})</h2>
        </div>
        {!childTasks || childTasks.length === 0 ? (
          <p className="text-gray-500 text-sm">No tasks created yet</p>
        ) : (
          <div className="space-y-3">
            {childTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50"
              >
                <div className="flex-1">
                  <Link
                    href={`/projects/${slug}/tasks/${task.id}`}
                    className="font-medium text-gray-900 hover:text-blue-600"
                  >
                    {task.title}
                  </Link>
                  <div className="flex items-center gap-3 mt-1">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${taskStateColors[task.state]}`}
                    >
                      {task.state}
                    </span>
                    {task.prUrl && (
                      <a
                        href={task.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        View PR
                      </a>
                    )}
                  </div>
                </div>
                {task.assignedAgentId && (
                  <Link
                    href={`/projects/${slug}/agents/${task.assignedAgentId}`}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    View Worker
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Workers */}
      {agents && agents.filter((a) => a.type === 'WORKER').length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Active Workers</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {agents
              .filter((a) => a.type === 'WORKER')
              .map((agent) => (
                <div key={agent.id} className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm">{agent.id.slice(0, 8)}...</span>
                    <span
                      className={`w-3 h-3 rounded-full ${agent.isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
                      title={agent.isHealthy ? 'Healthy' : 'Unhealthy'}
                    />
                  </div>
                  <p className="text-sm text-gray-600">State: {agent.state}</p>
                  <Link
                    href={`/projects/${slug}/agents/${agent.id}`}
                    className="text-sm text-blue-600 hover:text-blue-800 mt-2 inline-block"
                  >
                    View Details
                  </Link>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
