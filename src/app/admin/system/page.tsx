'use client';

import Link from 'next/link';
import { useState } from 'react';
import { trpc } from '../../../frontend/lib/trpc';

export default function AdminSystemPage() {
  const [rateLimits, setRateLimits] = useState({
    claudeRequestsPerMinute: 60,
    claudeRequestsPerHour: 1000,
    maxConcurrentWorkers: 10,
    maxConcurrentSupervisors: 5,
    maxConcurrentEpics: 5,
  });

  const { data: profiles } = trpc.admin.getAgentProfiles.useQuery();
  const { data: apiUsage } = trpc.admin.getApiUsageByAgent.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: stats, refetch: refetchStats } = trpc.admin.getSystemStats.useQuery();

  const updateRateLimits = trpc.admin.updateRateLimits.useMutation({
    onSuccess: () => {
      refetchStats();
    },
  });

  const handleSaveRateLimits = () => {
    updateRateLimits.mutate(rateLimits);
  };

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-foreground">System Settings</h1>
          <p className="text-muted-foreground mt-1">Configure system behavior and limits</p>
        </div>
        <Link
          href="/admin"
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80"
        >
          Back to Admin
        </Link>
      </div>

      {/* Agent Profiles */}
      <div className="bg-card rounded-lg border p-4">
        <h2 className="text-lg font-semibold mb-4">Agent Profiles</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Agent models and permissions can be configured via environment variables.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {profiles?.profiles &&
            Object.entries(profiles.profiles).map(([type, profile]) => (
              <div key={type} className="border border-border rounded-lg p-4">
                <h3 className="font-medium text-lg mb-2">{type}</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Model:</span>
                    <span className="font-mono text-xs">
                      {profile.model.split('-').slice(-2).join('-')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Permission Mode:</span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        profile.permissionMode === 'yolo'
                          ? 'bg-warning/15 text-warning-foreground'
                          : profile.permissionMode === 'relaxed'
                            ? 'bg-info/15 text-info'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {profile.permissionMode}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Max Tokens:</span>
                    <span>{profile.maxTokens.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
        </div>

        <div className="mt-4 p-4 bg-muted rounded-lg text-sm">
          <h4 className="font-medium mb-2">Environment Variables</h4>
          <ul className="space-y-1 font-mono text-xs">
            <li>
              <code>ORCHESTRATOR_MODEL</code>: sonnet, opus, haiku
            </li>
            <li>
              <code>SUPERVISOR_MODEL</code>: sonnet, opus, haiku
            </li>
            <li>
              <code>WORKER_MODEL</code>: sonnet, opus, haiku
            </li>
            <li>
              <code>ORCHESTRATOR_PERMISSIONS</code>: strict, relaxed, yolo
            </li>
            <li>
              <code>SUPERVISOR_PERMISSIONS</code>: strict, relaxed, yolo
            </li>
            <li>
              <code>WORKER_PERMISSIONS</code>: strict, relaxed, yolo
            </li>
          </ul>
        </div>
      </div>

      {/* Rate Limits */}
      <div className="bg-card rounded-lg border p-4">
        <h2 className="text-lg font-semibold mb-4">Rate Limits</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Claude Requests/min
            </label>
            <input
              type="number"
              value={rateLimits.claudeRequestsPerMinute}
              onChange={(e) =>
                setRateLimits({
                  ...rateLimits,
                  claudeRequestsPerMinute: Number.parseInt(e.target.value, 10),
                })
              }
              className="w-full px-3 py-2 border border-input rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Claude Requests/hour
            </label>
            <input
              type="number"
              value={rateLimits.claudeRequestsPerHour}
              onChange={(e) =>
                setRateLimits({
                  ...rateLimits,
                  claudeRequestsPerHour: Number.parseInt(e.target.value, 10),
                })
              }
              className="w-full px-3 py-2 border border-input rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Max Concurrent Workers
            </label>
            <input
              type="number"
              value={rateLimits.maxConcurrentWorkers}
              onChange={(e) =>
                setRateLimits({
                  ...rateLimits,
                  maxConcurrentWorkers: Number.parseInt(e.target.value, 10),
                })
              }
              className="w-full px-3 py-2 border border-input rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Max Concurrent Supervisors
            </label>
            <input
              type="number"
              value={rateLimits.maxConcurrentSupervisors}
              onChange={(e) =>
                setRateLimits({
                  ...rateLimits,
                  maxConcurrentSupervisors: Number.parseInt(e.target.value, 10),
                })
              }
              className="w-full px-3 py-2 border border-input rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Max Concurrent Epics
            </label>
            <input
              type="number"
              value={rateLimits.maxConcurrentEpics}
              onChange={(e) =>
                setRateLimits({
                  ...rateLimits,
                  maxConcurrentEpics: Number.parseInt(e.target.value, 10),
                })
              }
              className="w-full px-3 py-2 border border-input rounded-lg"
            />
          </div>
        </div>
        <div className="mt-4">
          <button
            onClick={handleSaveRateLimits}
            disabled={updateRateLimits.isPending}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            {updateRateLimits.isPending ? 'Saving...' : 'Save Rate Limits'}
          </button>
          {updateRateLimits.data && <span className="ml-4 text-success">Saved successfully!</span>}
        </div>
      </div>

      {/* API Usage by Agent */}
      <div className="bg-card rounded-lg border p-4">
        <h2 className="text-lg font-semibold mb-4">API Usage by Agent</h2>
        {apiUsage?.byAgent && Object.keys(apiUsage.byAgent).length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                    Agent ID
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">
                    Requests
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.entries(apiUsage.byAgent)
                  .sort(([, a], [, b]) => (b as number) - (a as number))
                  .slice(0, 20)
                  .map(([agentId, count]) => (
                    <tr key={agentId}>
                      <td className="px-4 py-2 text-sm font-mono">{agentId}</td>
                      <td className="px-4 py-2 text-sm text-right">{count as number}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground">No API usage data yet</p>
        )}
      </div>

      {/* API Usage by Top-Level Task */}
      <div className="bg-card rounded-lg border p-4">
        <h2 className="text-lg font-semibold mb-4">API Usage by Top-Level Task</h2>
        {apiUsage?.byTopLevelTask && Object.keys(apiUsage.byTopLevelTask).length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                    Task ID
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase">
                    Requests
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.entries(apiUsage.byTopLevelTask)
                  .sort(([, a], [, b]) => (b as number) - (a as number))
                  .map(([topLevelTaskId, count]) => (
                    <tr key={topLevelTaskId}>
                      <td className="px-4 py-2 text-sm">
                        <Link
                          href={`/tasks/${topLevelTaskId}`}
                          className="text-primary hover:text-primary/80"
                        >
                          {topLevelTaskId}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-sm text-right">{count as number}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground">No API usage data yet</p>
        )}
      </div>

      {/* Feature Flags */}
      <div className="bg-card rounded-lg border p-4">
        <h2 className="text-lg font-semibold mb-4">Feature Flags</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div>
              <span className="font-medium">Authentication</span>
              <p className="text-sm text-muted-foreground">Require authentication for all routes</p>
            </div>
            <span
              className={`px-2 py-1 rounded text-xs ${
                stats?.features?.authentication
                  ? 'bg-success/15 text-success'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {stats?.features?.authentication ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div>
              <span className="font-medium">Metrics</span>
              <p className="text-sm text-muted-foreground">Export Prometheus metrics</p>
            </div>
            <span
              className={`px-2 py-1 rounded text-xs ${
                stats?.features?.metrics
                  ? 'bg-success/15 text-success'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {stats?.features?.metrics ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <span className="font-medium">Error Tracking</span>
              <p className="text-sm text-muted-foreground">Send errors to tracking service</p>
            </div>
            <span
              className={`px-2 py-1 rounded text-xs ${
                stats?.features?.errorTracking
                  ? 'bg-success/15 text-success'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {stats?.features?.errorTracking ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-4">
          Feature flags are configured via environment variables:
          <code className="ml-2 font-mono text-xs">FEATURE_AUTHENTICATION=true</code>
        </p>
      </div>

      {/* Available Models */}
      <div className="bg-card rounded-lg border p-4">
        <h2 className="text-lg font-semibold mb-4">Available Models</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {profiles?.availableModels?.map((m) => (
            <div key={m.alias} className="border border-border rounded-lg p-3">
              <span className="font-medium">{m.alias}</span>
              <p className="text-xs font-mono text-muted-foreground mt-1">{m.model}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
