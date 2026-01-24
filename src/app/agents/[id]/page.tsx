'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { TmuxTerminal } from '../../../frontend/components/tmux-terminal';
import { trpc } from '../../../frontend/lib/trpc';
import type { AgentWithRelations } from '../../../frontend/lib/types';

const stateColors: Record<string, string> = {
  IDLE: 'bg-gray-100 text-gray-800',
  BUSY: 'bg-blue-100 text-blue-800',
  WAITING: 'bg-yellow-100 text-yellow-800',
  FAILED: 'bg-red-100 text-red-800',
};

function AgentDetailsCard({ agent }: { agent: AgentWithRelations }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-semibold mb-4">Agent Details</h2>
      <dl className="space-y-3">
        <div>
          <dt className="text-sm text-gray-500">Type</dt>
          <dd className="font-medium">{agent.type}</dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500">State</dt>
          <dd className="font-medium">{agent.state}</dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500">Health Status</dt>
          <dd className={`font-medium ${agent.isHealthy ? 'text-green-600' : 'text-red-600'}`}>
            {agent.isHealthy ? 'Healthy' : 'Unhealthy'}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500">Last Heartbeat</dt>
          <dd className="font-medium">{agent.minutesSinceHeartbeat ?? 0} minutes ago</dd>
        </div>
        {agent.tmuxSessionName && (
          <div>
            <dt className="text-sm text-gray-500">Tmux Session</dt>
            <dd className="font-mono text-sm">{agent.tmuxSessionName}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function RelatedResourcesCard({ agent }: { agent: AgentWithRelations }) {
  const hasEpic = !!agent.currentEpic;
  const hasTasks = agent.assignedTasks && agent.assignedTasks.length > 0;

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-semibold mb-4">Related Resources</h2>
      <dl className="space-y-3">
        {hasEpic && (
          <div>
            <dt className="text-sm text-gray-500">Current Epic</dt>
            <dd>
              <Link
                href={`/epics/${agent.currentEpic?.id}`}
                className="text-blue-600 hover:text-blue-800"
              >
                {agent.currentEpic?.title}
              </Link>
            </dd>
          </div>
        )}
        {hasTasks && (
          <div>
            <dt className="text-sm text-gray-500">Assigned Tasks</dt>
            <dd className="space-y-1">
              {agent.assignedTasks?.map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="block text-blue-600 hover:text-blue-800"
                >
                  {task.title}
                </Link>
              ))}
            </dd>
          </div>
        )}
        {!(hasEpic || hasTasks) && <p className="text-gray-500 text-sm">No related resources</p>}
      </dl>
    </div>
  );
}

interface DecisionLog {
  id: string;
  decision: string;
  reasoning: string;
  context?: string;
  timestamp: Date;
}

function DecisionLogsSection({
  logs,
  showFullLogs,
  onToggle,
}: {
  logs: DecisionLog[] | undefined;
  showFullLogs: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Decision Logs</h2>
        <button onClick={onToggle} className="text-blue-600 hover:text-blue-800 text-sm">
          {showFullLogs ? 'Show less' : 'Show more'}
        </button>
      </div>
      {!logs || logs.length === 0 ? (
        <p className="text-gray-500 text-sm">No decision logs yet</p>
      ) : (
        <div className="space-y-4 max-h-96 overflow-y-auto">
          {logs.map((log) => (
            <div key={log.id} className="border-l-2 border-gray-200 pl-4 py-2">
              <p className="font-medium text-sm">{log.decision}</p>
              <p className="text-sm text-gray-600 mt-1">{log.reasoning}</p>
              {log.context && (
                <details className="mt-2">
                  <summary className="text-xs text-gray-500 cursor-pointer">View context</summary>
                  <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-x-auto">
                    {log.context}
                  </pre>
                </details>
              )}
              <p className="text-xs text-gray-400 mt-1">
                {new Date(log.timestamp).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [showFullLogs, setShowFullLogs] = useState(false);

  const {
    data: agentData,
    isLoading,
    error,
  } = trpc.agent.getById.useQuery({ id }, { refetchInterval: 2000 });

  const agent = agentData as AgentWithRelations | undefined;

  const { data: logs } = trpc.decisionLog.listByAgent.useQuery(
    { agentId: id, limit: showFullLogs ? 100 : 10 },
    { refetchInterval: 5000 }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading agent...</div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-red-600 mb-4">Agent not found</p>
        <Link href="/agents" className="text-blue-600 hover:text-blue-800">
          Back to agents
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Link href="/agents" className="text-gray-500 hover:text-gray-700">
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
            <div className="flex items-center gap-3">
              <span
                className={`w-3 h-3 rounded-full ${agent.isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
              />
              <h1 className="text-2xl font-bold text-gray-900">{agent.type} Agent</h1>
            </div>
            <p className="text-gray-500 font-mono text-sm mt-1">{agent.id}</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded text-sm font-medium ${stateColors[agent.state]}`}>
          {agent.state}
        </span>
      </div>

      {/* Agent Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <AgentDetailsCard agent={agent} />
        <RelatedResourcesCard agent={agent} />
      </div>

      {/* Terminal Viewer */}
      {agent.tmuxSessionName && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">Terminal Output</h2>
          <TmuxTerminal sessionName={agent.tmuxSessionName} />
        </div>
      )}

      {/* Decision Logs */}
      <DecisionLogsSection
        logs={logs}
        showFullLogs={showFullLogs}
        onToggle={() => setShowFullLogs(!showFullLogs)}
      />
    </div>
  );
}
