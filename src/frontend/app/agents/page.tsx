'use client';

import Link from 'next/link';
import { trpc } from '../../lib/trpc';

const stateColors: Record<string, string> = {
  IDLE: 'bg-gray-100 text-gray-800',
  BUSY: 'bg-blue-100 text-blue-800',
  WAITING: 'bg-yellow-100 text-yellow-800',
  FAILED: 'bg-red-100 text-red-800',
};

interface AgentWithHealth {
  id: string;
  type: string;
  state: string;
  isHealthy: boolean;
  minutesSinceHeartbeat: number;
  tmuxSessionName: string | null;
  currentEpic?: { id: string; title: string } | null;
  assignedTasks?: { id: string; title: string }[];
}

function AgentCard({ agent }: { agent: AgentWithHealth }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-4 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={`w-3 h-3 rounded-full ${agent.isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
            title={agent.isHealthy ? 'Healthy' : 'Unhealthy'}
          />
          <span className="font-mono text-sm">{agent.id.slice(0, 8)}...</span>
        </div>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${stateColors[agent.state]}`}>
          {agent.state}
        </span>
      </div>

      <div className="space-y-1 text-sm text-gray-600 mb-3">
        <p>
          Last heartbeat:{' '}
          <span className={agent.minutesSinceHeartbeat > 5 ? 'text-red-600' : ''}>
            {agent.minutesSinceHeartbeat}m ago
          </span>
        </p>
        {agent.currentEpic && (
          <p>
            Epic:{' '}
            <Link
              href={`/epics/${agent.currentEpic.id}`}
              className="text-blue-600 hover:text-blue-800"
            >
              {agent.currentEpic.title.slice(0, 30)}...
            </Link>
          </p>
        )}
        {agent.assignedTasks && agent.assignedTasks.length > 0 && (
          <p>Tasks: {agent.assignedTasks.length}</p>
        )}
      </div>

      <Link
        href={`/agents/${agent.id}`}
        className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
  );
}

function AgentSection({
  title,
  agents,
  emptyText,
}: {
  title: string;
  agents: AgentWithHealth[];
  emptyText: string;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        {title}
        <span className="text-sm font-normal text-gray-500">({agents.length})</span>
      </h2>
      {agents.length === 0 ? (
        <p className="text-gray-500 text-sm bg-white rounded-lg p-4">{emptyText}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentsPage() {
  const { data, isLoading } = trpc.agent.listGrouped.useQuery(undefined, {
    refetchInterval: 2000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading agents...</div>
      </div>
    );
  }

  const orchestrators = (data?.orchestrators || []) as AgentWithHealth[];
  const supervisors = (data?.supervisors || []) as AgentWithHealth[];
  const workers = (data?.workers || []) as AgentWithHealth[];

  const totalAgents = orchestrators.length + supervisors.length + workers.length;
  const healthyAgents = [...orchestrators, ...supervisors, ...workers].filter(
    (a) => a.isHealthy
  ).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Agent Monitor</h1>
        <p className="text-gray-600 mt-1">Real-time monitoring of all system agents</p>
      </div>

      {/* Summary */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div>
              <p className="text-sm text-gray-600">Total Agents</p>
              <p className="text-2xl font-bold">{totalAgents}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Healthy</p>
              <p className="text-2xl font-bold text-green-600">{healthyAgents}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Unhealthy</p>
              <p className="text-2xl font-bold text-red-600">{totalAgents - healthyAgents}</p>
            </div>
          </div>
          <div className="text-sm text-gray-500">Auto-refreshing every 2 seconds</div>
        </div>
      </div>

      {/* Agent Groups */}
      <AgentSection
        title="Orchestrators"
        agents={orchestrators}
        emptyText="No orchestrator agents running"
      />

      <AgentSection
        title="Supervisors"
        agents={supervisors}
        emptyText="No supervisor agents running"
      />

      <AgentSection title="Workers" agents={workers} emptyText="No worker agents running" />
    </div>
  );
}
