'use client';

import { use } from 'react';
import Link from 'next/link';
import { trpc } from '../../../lib/trpc';

const stateColors: Record<string, string> = {
  PENDING: 'bg-gray-100 text-gray-800',
  ASSIGNED: 'bg-yellow-100 text-yellow-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  REVIEW: 'bg-purple-100 text-purple-800',
  BLOCKED: 'bg-red-100 text-red-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
};

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const {
    data: task,
    isLoading,
    error,
  } = trpc.task.getById.useQuery({ id }, { refetchInterval: 5000 });

  const { data: agent } = trpc.agent.getById.useQuery(
    { id: task?.assignedAgentId || '' },
    {
      enabled: !!task?.assignedAgentId,
      refetchInterval: 2000,
    }
  );

  const { data: logs } = trpc.decisionLog.listByAgent.useQuery(
    { agentId: task?.assignedAgentId || '', limit: 10 },
    {
      enabled: !!task?.assignedAgentId,
      refetchInterval: 5000,
    }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading task...</div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-red-600 mb-4">Task not found</p>
        <Link href="/tasks" className="text-blue-600 hover:text-blue-800">
          Back to tasks
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Link href="/tasks" className="text-gray-500 hover:text-gray-700">
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
            <h1 className="text-2xl font-bold text-gray-900">{task.title}</h1>
            <div className="flex items-center gap-3 mt-2">
              <span className={`px-2 py-1 rounded text-xs font-medium ${stateColors[task.state]}`}>
                {task.state}
              </span>
              <span className="text-sm text-gray-500">
                Created {new Date(task.createdAt).toLocaleDateString()}
              </span>
              {task.attempts > 0 && (
                <span className="text-sm text-gray-500">Attempts: {task.attempts}</span>
              )}
            </div>
          </div>
        </div>
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 text-sm"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
            View Pull Request
          </a>
        )}
      </div>

      {/* Epic Link */}
      {(task as { epic?: { title: string } }).epic && (
        <div className="bg-white rounded-lg shadow-sm p-4">
          <p className="text-sm text-gray-600">
            Part of epic:{' '}
            <Link href={`/epics/${task.epicId}`} className="text-blue-600 hover:text-blue-800">
              {(task as { epic?: { title: string } }).epic?.title}
            </Link>
          </p>
        </div>
      )}

      {/* Description */}
      {task.description && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-3">Description</h2>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">
            {task.description}
          </pre>
        </div>
      )}

      {/* Failure Info */}
      {task.failureReason && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-red-800 mb-3">Failure Reason</h2>
          <pre className="whitespace-pre-wrap text-sm text-red-700 font-mono">
            {task.failureReason}
          </pre>
        </div>
      )}

      {/* Worker Info */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-semibold mb-4">Worker Agent</h2>
        {agent ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">
                  Agent ID: <span className="font-mono">{agent.id}</span>
                </p>
                <p className="text-sm text-gray-600">State: {agent.state}</p>
                <p className="text-sm text-gray-600">
                  Health:{' '}
                  <span className={agent.isHealthy ? 'text-green-600' : 'text-red-600'}>
                    {agent.isHealthy ? 'Healthy' : 'Unhealthy'}
                  </span>
                  <span className="text-gray-500 ml-2">
                    ({agent.minutesSinceHeartbeat}m since last heartbeat)
                  </span>
                </p>
              </div>
              <Link
                href={`/agents/${agent.id}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 text-sm"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
                View Terminal
              </Link>
            </div>

            {/* Branch & Worktree Info */}
            {task.branchName && (
              <div className="pt-4 border-t">
                <p className="text-sm text-gray-600">
                  Branch: <span className="font-mono">{task.branchName}</span>
                </p>
                {task.worktreePath && (
                  <p className="text-sm text-gray-600">
                    Worktree: <span className="font-mono text-xs">{task.worktreePath}</span>
                  </p>
                )}
              </div>
            )}
          </div>
        ) : task.assignedAgentId ? (
          <p className="text-gray-500 text-sm">Loading worker info...</p>
        ) : (
          <p className="text-gray-500 text-sm">No worker assigned yet</p>
        )}
      </div>

      {/* Recent Decision Logs */}
      {logs && logs.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Recent Activity</h2>
            {task.assignedAgentId && (
              <Link
                href={`/logs?agentId=${task.assignedAgentId}`}
                className="text-blue-600 hover:text-blue-800 text-sm"
              >
                View all logs
              </Link>
            )}
          </div>
          <div className="space-y-3">
            {logs.slice(0, 5).map((log) => (
              <div key={log.id} className="border-l-2 border-gray-200 pl-4 py-2">
                <p className="font-medium text-sm">{log.decision}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(log.timestamp).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
