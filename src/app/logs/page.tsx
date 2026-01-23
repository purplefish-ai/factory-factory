'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '../../frontend/lib/trpc';
import type { DecisionLogWithRelations } from '../../frontend/lib/types';

export default function LogsPage() {
  const [agentFilter, setAgentFilter] = useState('');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const { data: logsData, isLoading } = trpc.decisionLog.listRecent.useQuery(
    { limit: 100 },
    { refetchInterval: 5000 }
  );

  // Cast to include relations
  const logs = logsData as DecisionLogWithRelations[] | undefined;

  const { data: agents } = trpc.agent.list.useQuery();

  const filteredLogs = logs?.filter((log) => {
    if (!agentFilter) return true;
    return log.agentId === agentFilter;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading logs...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Decision Logs</h1>
        <p className="text-gray-600 mt-1">Audit trail of all agent decisions</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex gap-4 items-center">
          <label className="text-sm font-medium text-gray-700">Filter by agent:</label>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All Agents</option>
            {agents?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.type} - {agent.id.slice(0, 8)}...
              </option>
            ))}
          </select>
          {agentFilter && (
            <button
              onClick={() => setAgentFilter('')}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Clear filter
            </button>
          )}
        </div>
      </div>

      {/* Logs List */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {!filteredLogs || filteredLogs.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p>No decision logs found</p>
            {agentFilter && (
              <button
                onClick={() => setAgentFilter('')}
                className="text-blue-600 hover:text-blue-800 mt-2"
              >
                Clear filter
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y">
            {filteredLogs.map((log) => (
              <div key={log.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {log.agent && (
                        <Link
                          href={`/agents/${log.agentId}`}
                          className="text-xs px-2 py-0.5 bg-gray-100 rounded text-gray-600 hover:bg-gray-200"
                        >
                          {log.agent.type}
                        </Link>
                      )}
                      <span className="text-xs text-gray-400">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <p className="font-medium text-gray-900">{log.decision}</p>
                    <p className="text-sm text-gray-600 mt-1">{log.reasoning}</p>
                    {log.context && (
                      <div className="mt-2">
                        <button
                          onClick={() =>
                            setExpandedLogId(expandedLogId === log.id ? null : log.id)
                          }
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          {expandedLogId === log.id ? 'Hide context' : 'Show context'}
                        </button>
                        {expandedLogId === log.id && (
                          <pre className="mt-2 text-xs bg-gray-50 p-3 rounded overflow-x-auto max-h-64">
                            {log.context}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                  <Link
                    href={`/agents/${log.agentId}`}
                    className="text-sm text-blue-600 hover:text-blue-800 ml-4"
                  >
                    View Agent
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
