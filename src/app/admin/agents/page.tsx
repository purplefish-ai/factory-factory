'use client';

import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

function AgentStateIndicator({ state, isInCrashLoop }: { state: string; isInCrashLoop: boolean }) {
  const stateColors: Record<string, string> = {
    IDLE: 'bg-muted text-muted-foreground',
    ACTIVE: 'bg-info/15 text-info',
    PAUSED: 'bg-warning/15 text-warning-foreground',
    CRASHED: 'bg-destructive/15 text-destructive',
  };

  return (
    <div className="flex items-center gap-2">
      <span className={`px-2 py-1 rounded text-xs font-medium ${stateColors[state] || 'bg-muted'}`}>
        {state}
      </span>
      {isInCrashLoop && (
        <span className="px-2 py-1 rounded text-xs font-medium bg-destructive text-destructive-foreground">
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
        <div className="animate-pulse text-muted-foreground">Loading agents...</div>
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
          <h1 className="text-2xl font-bold text-foreground">Agent Management</h1>
          <p className="text-muted-foreground mt-1">View and manage all running agents</p>
        </div>
        <Link
          href="/admin"
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80"
        >
          Back to Admin
        </Link>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-card p-4 rounded-lg border">
          <h3 className="text-sm font-medium text-muted-foreground">Total Agents</h3>
          <p className="text-2xl font-bold">{agents?.length || 0}</p>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <h3 className="text-sm font-medium text-muted-foreground">Orchestrators</h3>
          <p className="text-2xl font-bold">{orchestrators.length}</p>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <h3 className="text-sm font-medium text-muted-foreground">Supervisors</h3>
          <p className="text-2xl font-bold">{supervisors.length}</p>
        </div>
        <div className="bg-card p-4 rounded-lg border">
          <h3 className="text-sm font-medium text-muted-foreground">Workers</h3>
          <p className="text-2xl font-bold">{workers.length}</p>
        </div>
      </div>

      {/* Orchestrators */}
      {orchestrators.length > 0 && (
        <div className="bg-card rounded-lg border overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-lg font-semibold">Orchestrators</h2>
          </div>
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Last Active
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orchestrators.map((agent) => (
                <tr key={agent.id} className="hover:bg-muted">
                  <td className="px-6 py-4 text-sm font-mono">{agent.id.slice(0, 8)}...</td>
                  <td className="px-6 py-4">
                    <AgentStateIndicator
                      state={agent.executionState}
                      isInCrashLoop={agent.isInCrashLoop}
                    />
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {agent.lastHeartbeat ? new Date(agent.lastHeartbeat).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {agent.isInCrashLoop && (
                        <button
                          onClick={() => clearCrashRecords.mutate({ agentId: agent.id })}
                          disabled={clearCrashRecords.isPending}
                          className="text-xs text-primary hover:text-primary/80"
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
      <div className="bg-card rounded-lg border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">Supervisors</h2>
        </div>
        {supervisors.length === 0 ? (
          <div className="p-6 text-muted-foreground">No supervisors running</div>
        ) : (
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Task
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Session
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Last Active
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {supervisors.map((agent) => (
                <tr key={agent.id} className="hover:bg-muted">
                  <td className="px-6 py-4 text-sm font-mono">
                    <Link
                      href={`/agents/${agent.id}`}
                      className="text-primary hover:text-primary/80"
                    >
                      {agent.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    <AgentStateIndicator
                      state={agent.executionState}
                      isInCrashLoop={agent.isInCrashLoop}
                    />
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {agent.currentTaskId ? (
                      <Link
                        href={`/tasks/${agent.currentTaskId}`}
                        className="text-primary hover:text-primary/80"
                      >
                        {agent.currentTaskId.slice(0, 8)}...
                      </Link>
                    ) : (
                      <span className="text-muted-foreground/50">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm font-mono text-muted-foreground">
                    {agent.tmuxSessionName || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {agent.lastHeartbeat ? new Date(agent.lastHeartbeat).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          restartAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={restartAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-info/15 text-info rounded hover:bg-info/25"
                      >
                        Restart
                      </button>
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          killAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={killAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-destructive/15 text-destructive rounded hover:bg-destructive/25"
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
      <div className="bg-card rounded-lg border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">Workers</h2>
        </div>
        {workers.length === 0 ? (
          <div className="p-6 text-muted-foreground">No workers running</div>
        ) : (
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  State
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Task
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Session
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Last Active
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {workers.map((agent) => (
                <tr key={agent.id} className="hover:bg-muted">
                  <td className="px-6 py-4 text-sm font-mono">
                    <Link
                      href={`/agents/${agent.id}`}
                      className="text-primary hover:text-primary/80"
                    >
                      {agent.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    <AgentStateIndicator
                      state={agent.executionState}
                      isInCrashLoop={agent.isInCrashLoop}
                    />
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {agent.currentTaskId ? (
                      <Link
                        href={`/tasks/${agent.currentTaskId}`}
                        className="text-primary hover:text-primary/80"
                      >
                        {agent.currentTaskId.slice(0, 8)}...
                      </Link>
                    ) : (
                      <span className="text-muted-foreground/50">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm font-mono text-muted-foreground">
                    {agent.tmuxSessionName || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {agent.lastHeartbeat ? new Date(agent.lastHeartbeat).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          restartAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={restartAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-info/15 text-info rounded hover:bg-info/25"
                      >
                        Restart
                      </button>
                      <button
                        onClick={() => {
                          setSelectedAgent(agent.id);
                          killAgent.mutate({ agentId: agent.id });
                        }}
                        disabled={killAgent.isPending && selectedAgent === agent.id}
                        className="text-xs px-2 py-1 bg-destructive/15 text-destructive rounded hover:bg-destructive/25"
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
        <div className="fixed bottom-4 right-4 bg-success/10 border border-success/30 p-4 rounded-lg shadow-lg">
          {killAgent.data.message}
        </div>
      )}
      {restartAgent.data && (
        <div className="fixed bottom-4 right-4 bg-success/10 border border-success/30 p-4 rounded-lg shadow-lg">
          {restartAgent.data.message}
          {restartAgent.data.newAgentId && (
            <p className="text-sm mt-1">New agent: {restartAgent.data.newAgentId}</p>
          )}
        </div>
      )}
    </div>
  );
}
