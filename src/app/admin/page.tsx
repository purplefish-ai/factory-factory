'use client';

import Link from 'next/link';
import { trpc } from '../../frontend/lib/trpc';

function StatCard({
  title,
  value,
  subtitle,
  status,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  status?: 'ok' | 'warning' | 'error';
}) {
  const statusColors = {
    ok: 'border-green-500',
    warning: 'border-yellow-500',
    error: 'border-red-500',
  };

  return (
    <div
      className={`bg-white p-6 rounded-lg shadow-sm border-l-4 ${status ? statusColors[status] : 'border-gray-200'}`}
    >
      <h3 className="text-sm font-medium text-gray-600">{title}</h3>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

function IssuesList({ issues }: { issues: string[] }) {
  if (issues.length === 0) {
    return (
      <div className="text-green-600 flex items-center gap-2">
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clipRule="evenodd"
          />
        </svg>
        No issues detected
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {issues.map((issue) => (
        <li key={issue} className="flex items-center gap-2 text-red-600">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
          {issue}
        </li>
      ))}
    </ul>
  );
}

function SummaryRow({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-600">{label}</span>
      <span className={`font-medium ${className || ''}`}>{value}</span>
    </div>
  );
}

function EpicsSummary({
  epics,
}: {
  epics?: {
    total: number;
    planning: number;
    inProgress: number;
    completed: number;
    blocked: number;
  };
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-semibold mb-4">Epics Summary</h2>
      <div className="space-y-2">
        <SummaryRow label="Total" value={epics?.total || 0} />
        <SummaryRow label="Planning" value={epics?.planning || 0} />
        <SummaryRow label="In Progress" value={epics?.inProgress || 0} />
        <SummaryRow label="Completed" value={epics?.completed || 0} className="text-green-600" />
        <SummaryRow label="Blocked" value={epics?.blocked || 0} className="text-red-600" />
      </div>
    </div>
  );
}

function TasksSummary({
  tasks,
}: {
  tasks?: {
    total: number;
    pending: number;
    inProgress: number;
    review: number;
    completed: number;
    failed: number;
  };
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-semibold mb-4">Tasks Summary</h2>
      <div className="space-y-2">
        <SummaryRow label="Total" value={tasks?.total || 0} />
        <SummaryRow label="Pending" value={tasks?.pending || 0} />
        <SummaryRow label="In Progress" value={tasks?.inProgress || 0} />
        <SummaryRow label="In Review" value={tasks?.review || 0} className="text-purple-600" />
        <SummaryRow label="Completed" value={tasks?.completed || 0} className="text-green-600" />
        <SummaryRow label="Failed" value={tasks?.failed || 0} className="text-red-600" />
      </div>
    </div>
  );
}

function WorktreesByReason({ byReason }: { byReason?: Record<string, number> }) {
  const hasReasons = byReason && Object.keys(byReason).length > 0;
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200">
      <h3 className="text-sm font-medium text-gray-600">By Reason</h3>
      <div className="mt-2 space-y-1 text-sm">
        {hasReasons ? (
          Object.entries(byReason).map(([reason, count]) => (
            <div key={reason} className="flex justify-between">
              <span className="text-gray-600">{reason}</span>
              <span className="font-medium">{count}</span>
            </div>
          ))
        ) : (
          <span className="text-gray-500">None</span>
        )}
      </div>
    </div>
  );
}

function getEnabledFeatures(features?: Record<string, boolean>): string {
  if (!features) {
    return 'none';
  }
  const enabled = Object.entries(features)
    .filter(([, isEnabled]) => isEnabled)
    .map(([feature]) => feature);
  return enabled.length > 0 ? enabled.join(', ') : 'none';
}

interface HealthData {
  isHealthy: boolean;
  databaseConnected: boolean;
  orchestratorHealthy: boolean;
  crashLoopAgents?: string[];
  issues?: string[];
}

function SystemHealthSection({ health }: { health?: HealthData }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-semibold mb-4">System Health</h2>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Overall Status"
          value={health?.isHealthy ? 'Healthy' : 'Degraded'}
          status={health?.isHealthy ? 'ok' : 'error'}
        />
        <StatCard
          title="Database"
          value={health?.databaseConnected ? 'Connected' : 'Disconnected'}
          status={health?.databaseConnected ? 'ok' : 'error'}
        />
        <StatCard
          title="Orchestrator"
          value={health?.orchestratorHealthy ? 'Running' : 'Stopped'}
          status={health?.orchestratorHealthy ? 'ok' : 'warning'}
        />
        <StatCard
          title="Crash Loops"
          value={health?.crashLoopAgents?.length || 0}
          status={health?.crashLoopAgents?.length ? 'error' : 'ok'}
        />
      </div>
      <h3 className="font-medium mb-2">Issues</h3>
      <IssuesList issues={health?.issues || []} />
    </div>
  );
}

interface ApiUsageData {
  requestsLastMinute: number;
  requestsLastHour: number;
  totalRequests: number;
  queueDepth: number;
  isRateLimited: boolean;
}

function ApiUsageSection({
  apiUsage,
  onReset,
  isResetting,
}: {
  apiUsage?: ApiUsageData;
  onReset: () => void;
  isResetting: boolean;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">API Usage</h2>
        <button
          onClick={onReset}
          disabled={isResetting}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          Reset Stats
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          title="Requests/min"
          value={apiUsage?.requestsLastMinute || 0}
          status={apiUsage?.isRateLimited ? 'warning' : 'ok'}
        />
        <StatCard title="Requests/hour" value={apiUsage?.requestsLastHour || 0} />
        <StatCard title="Total Requests" value={apiUsage?.totalRequests || 0} />
        <StatCard
          title="Queue Depth"
          value={apiUsage?.queueDepth || 0}
          status={apiUsage?.queueDepth && apiUsage.queueDepth > 10 ? 'warning' : 'ok'}
        />
      </div>
    </div>
  );
}

interface ConcurrencyData {
  activeWorkers: number;
  activeSupervisors: number;
  activeEpics: number;
  limits: { maxWorkers: number; maxSupervisors: number; maxEpics: number };
}

function ConcurrencySection({ concurrency }: { concurrency?: ConcurrencyData }) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h2 className="text-lg font-semibold mb-4">Concurrency</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          title="Active Workers"
          value={`${concurrency?.activeWorkers || 0} / ${concurrency?.limits?.maxWorkers || 0}`}
        />
        <StatCard
          title="Active Supervisors"
          value={`${concurrency?.activeSupervisors || 0} / ${concurrency?.limits?.maxSupervisors || 0}`}
        />
        <StatCard
          title="Active Epics"
          value={`${concurrency?.activeEpics || 0} / ${concurrency?.limits?.maxEpics || 0}`}
        />
      </div>
    </div>
  );
}

export default function AdminDashboardPage() {
  const {
    data: stats,
    isLoading,
    refetch,
  } = trpc.admin.getSystemStats.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const triggerHealthCheck = trpc.admin.triggerHealthCheck.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  const cleanupWorktrees = trpc.admin.cleanupWorktrees.useMutation();
  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-gray-500">Loading admin dashboard...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
          <p className="text-gray-600 mt-1">System monitoring and management</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => triggerHealthCheck.mutate()}
            disabled={triggerHealthCheck.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {triggerHealthCheck.isPending ? 'Checking...' : 'Run Health Check'}
          </button>
        </div>
      </div>

      <SystemHealthSection health={stats?.health} />

      <ApiUsageSection
        apiUsage={stats?.apiUsage}
        onReset={() => resetApiStats.mutate()}
        isResetting={resetApiStats.isPending}
      />

      <ConcurrencySection concurrency={stats?.concurrency} />

      {/* Epics & Tasks Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <EpicsSummary epics={stats?.epics} />
        <TasksSummary tasks={stats?.tasks} />
      </div>

      {/* Worktrees */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Worktrees</h2>
          <button
            onClick={() => cleanupWorktrees.mutate()}
            disabled={cleanupWorktrees.isPending}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm"
          >
            {cleanupWorktrees.isPending ? 'Cleaning...' : 'Cleanup Orphaned'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard title="Total Worktrees" value={stats?.worktrees.total || 0} />
          <StatCard
            title="Orphaned"
            value={stats?.worktrees.orphaned || 0}
            status={stats?.worktrees.orphaned ? 'warning' : 'ok'}
          />
          <WorktreesByReason byReason={stats?.worktrees.byReason} />
        </div>
        {cleanupWorktrees.data && (
          <div className="mt-4 p-3 bg-green-50 rounded-lg text-green-700 text-sm">
            Cleaned {cleanupWorktrees.data.cleaned} worktrees. {cleanupWorktrees.data.failed}{' '}
            failed.
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-lg font-semibold mb-4">Admin Actions</h2>
        <div className="flex gap-4 flex-wrap">
          <Link
            href="/admin/agents"
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            Manage Agents
          </Link>
          <Link
            href="/admin/system"
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            System Settings
          </Link>
          <Link
            href="/logs"
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            View Logs
          </Link>
        </div>
      </div>

      {/* Environment Info */}
      <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-600">
        <span className="font-medium">Environment:</span> {stats?.environment || 'unknown'} |{' '}
        <span className="font-medium">Features:</span> {getEnabledFeatures(stats?.features)}
      </div>
    </div>
  );
}
