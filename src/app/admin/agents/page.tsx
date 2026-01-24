'use client';

import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

function AgentStateIndicator({ state, isInCrashLoop }: { state: string; isInCrashLoop: boolean }) {
  const stateColors: Record<string, string> = {
    IDLE: 'bg-gray-100 text-gray-800',
    BUSY: 'bg-blue-100 text-blue-800',
    WAITING: 'bg-yellow-100 text-yellow-800',
    FAILED: 'bg-red-100 text-red-800',
  };

  return (
    <div className="flex items-center gap-2">
      <span
        className={`px-2 py-1 rounded text-xs font-medium ${stateColors[state] || 'bg-gray-100'}`}
      >
        {state}
      </span>
      {isInCrashLoop && (
        <span className="px-2 py-1 rounded text-xs font-medium bg-red-500 text-white">
          CRASH LOOP
        </span>
      )}
    </div>
  );
}

export default function AdminAgentsPage() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data: agents, isLoading } = trpc.admin.listAgents.useQuery(undefined, {
    refetchInterval: 3000,
  });

  const killAgent = trpc.admin.killAgent.useMutation({
    onSuccess: () => {
      utils.admin.listAgents.invalidate();
    },
  });

  const restartAgent = trpc.admin.restartAgent.useMutation({
    onSuccess: () => {
      utils.admin.listAgents.invalidate();
    },
  });

  const clearCrashRecords = trpc.admin.clearCrashRecords.useMutation({
    onSuccess: () => {
      utils.admin.listAgents.invalidate();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading agents...</div>
      </div>
    );
  }

  const supervisors = agents?.filter((a) => a.type === 'SUPERVISOR') || [];
  const workers = agents?.filter((a) => a.type === 'WORKER') || [];
  const orchestrators = agents?.filter((a) => a.type === 'ORCHESTRATOR') || [];

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agent Management</h1>
          <p className="text-gray-600 mt-1">View and manage all running agents</p>
        </div>
        <Link
          href="/admin"
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
        >
          Back to Admin
        </Link>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-lg shadow-sm">
          <h3 className="text-sm font-medium text-gray-600">Total Agents</h3>
          <p className="text-2xl font-bold">{agents?.length || 0}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm">
          <h3 className="text-sm font-medium text-gray-600">Orchestrators</h3>
          <p className="text-2xl font-bold">{orchestrators.length}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm">
          <h3 className="text-sm font-medium text-gray-600">Supervisors</h3>
          <p className="text-2xl font-bold">{supervisors.length}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm">
          <h3 className="text-sm font-medium text-gray-600">Workers</h3>
          <p className="text-2xl font-bold">{workers.length}</p>
        </div>
      </div>

      {/* Orchestrators */}
      {orchestrators.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold">Orchestrators</h2>
          </div>
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Last Active
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {orchestrators.map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-mono">{agent.id.slice(0, 8)}...</td>
                  <td className="px-6 py-4">
                    <AgentStateIndicator state={agent.state} isInCrashLoop={agent.isInCrashLoop} />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {new Date(agent.lastActiveAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {agent.isInCrashLoop && (
                        <button
                          onClick={() => clearCrashRecords.mutate({ agentId: agent.id })}
                          disabled={clearCrashRecords.isPending}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          Clear Crash Records
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Supervisors */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Supervisors</h2>
        </div>
        {supervisors.length === 0 ? (
          <div className="p-6 text-gray-500">No supervisors running</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Task
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Session
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Last Active
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {supervisors.map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-mono">
                    <Link
                      href={`/agents/${agent.id}`}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      {agent.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    <AgentStateIndicator state={agent.state} isInCrashLoop={agent.isInCrashLoop} />
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {agent.currentTaskId ? (
                      <Link
                        href={`/tasks/${agent.currentTaskId}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        {agent.currentTaskId.slice(0, 8)}...
                      </Link>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm font-mono text-gray-600">
                    {agent.tmuxSessionName || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {new Date(agent.lastActiveAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          restartAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={restartAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                      >
                        Restart
                      </button>
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          killAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={killAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
                      >
                        Kill
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Workers */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Workers</h2>
        </div>
        {workers.length === 0 ? (
          <div className="p-6 text-gray-500">No workers running</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Task
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Session
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Last Active
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {workers.map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm font-mono">
                    <Link
                      href={`/agents/${agent.id}`}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      {agent.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    <AgentStateIndicator state={agent.state} isInCrashLoop={agent.isInCrashLoop} />
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {agent.currentTaskId ? (
                      <Link
                        href={`/tasks/${agent.currentTaskId}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        {agent.currentTaskId.slice(0, 8)}...
                      </Link>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm font-mono text-gray-600">
                    {agent.tmuxSessionName || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {new Date(agent.lastActiveAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          restartAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={restartAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                      >
                        Restart
                      </button>
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          killAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={killAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
                      >
                        Kill
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Action Results */}
      {killAgent.data && (
        <div className="fixed bottom-4 right-4 bg-green-50 border border-green-200 p-4 rounded-lg shadow-lg">
          {killAgent.data.message}
        </div>
      )}
      {restartAgent.data && (
        <div className="fixed bottom-4 right-4 bg-green-50 border border-green-200 p-4 rounded-lg shadow-lg">
          {restartAgent.data.message}
          {restartAgent.data.newAgentId && (
            <p className="text-sm mt-1">New agent: {restartAgent.data.newAgentId}</p>
          )}
        </div>
      )}
    </div>
  );
}
