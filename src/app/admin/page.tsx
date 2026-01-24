'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
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
    ok: 'border-l-green-500',
    warning: 'border-l-yellow-500',
    error: 'border-l-red-500',
  };

  return (
    <Card className={`border-l-4 ${status ? statusColors[status] : 'border-l-muted'}`}>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {subtitle && (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </CardContent>
      )}
    </Card>
  );
}

function IssuesList({ issues }: { issues: string[] }) {
  if (issues.length === 0) {
    return (
      <div className="text-green-600 flex items-center gap-2">
        <CheckCircle2 className="w-5 h-5" />
        No issues detected
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {issues.map((issue) => (
        <li key={issue} className="flex items-center gap-2 text-red-600">
          <XCircle className="w-5 h-5" />
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
      <span className="text-muted-foreground">{label}</span>
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
    <Card>
      <CardHeader>
        <CardTitle>Epics Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <SummaryRow label="Total" value={epics?.total || 0} />
        <SummaryRow label="Planning" value={epics?.planning || 0} />
        <SummaryRow label="In Progress" value={epics?.inProgress || 0} />
        <SummaryRow label="Completed" value={epics?.completed || 0} className="text-green-600" />
        <SummaryRow label="Blocked" value={epics?.blocked || 0} className="text-red-600" />
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Tasks Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <SummaryRow label="Total" value={tasks?.total || 0} />
        <SummaryRow label="Pending" value={tasks?.pending || 0} />
        <SummaryRow label="In Progress" value={tasks?.inProgress || 0} />
        <SummaryRow label="In Review" value={tasks?.review || 0} className="text-purple-600" />
        <SummaryRow label="Completed" value={tasks?.completed || 0} className="text-green-600" />
        <SummaryRow label="Failed" value={tasks?.failed || 0} className="text-red-600" />
      </CardContent>
    </Card>
  );
}

function WorktreesByReason({ byReason }: { byReason?: Record<string, number> }) {
  const hasReasons = byReason && Object.keys(byReason).length > 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>By Reason</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {hasReasons ? (
          Object.entries(byReason).map(([reason, count]) => (
            <div key={reason} className="flex justify-between">
              <span className="text-muted-foreground">{reason}</span>
              <span className="font-medium">{count}</span>
            </div>
          ))
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>System Health</CardTitle>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle>API Usage</CardTitle>
        <Button variant="link" onClick={onReset} disabled={isResetting} className="h-auto p-0">
          Reset Stats
        </Button>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

interface ConcurrencyData {
  activeWorkers: number;
  activeSupervisors: number;
  activeTopLevelTasks: number;
  limits: { maxWorkers: number; maxSupervisors: number; maxTopLevelTasks: number };
}

function ConcurrencySection({ concurrency }: { concurrency?: ConcurrencyData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Concurrency</CardTitle>
      </CardHeader>
      <CardContent>
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
            title="Active Top-Level Tasks"
            value={`${concurrency?.activeTopLevelTasks || 0} / ${concurrency?.limits?.maxTopLevelTasks || 0}`}
          />
        </div>
      </CardContent>
    </Card>
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
    return <Loading message="Loading admin dashboard..." />;
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Admin Dashboard" description="System monitoring and management">
        <Button onClick={() => triggerHealthCheck.mutate()} disabled={triggerHealthCheck.isPending}>
          {triggerHealthCheck.isPending ? 'Checking...' : 'Run Health Check'}
        </Button>
      </PageHeader>

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
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle>Worktrees</CardTitle>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => cleanupWorktrees.mutate()}
            disabled={cleanupWorktrees.isPending}
          >
            {cleanupWorktrees.isPending ? 'Cleaning...' : 'Cleanup Orphaned'}
          </Button>
        </CardHeader>
        <CardContent>
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
            <Alert className="mt-4 border-green-200 bg-green-50 text-green-700">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>
                Cleaned {cleanupWorktrees.data.cleaned} worktrees. {cleanupWorktrees.data.failed}{' '}
                failed.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle>Admin Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 flex-wrap">
            <Button variant="secondary" asChild>
              <Link href="/admin/agents">Manage Agents</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/admin/system">System Settings</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/logs">View Logs</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Environment Info */}
      <Card className="bg-muted/50">
        <CardContent className="py-4">
          <span className="font-medium">Environment:</span>{' '}
          <Badge variant="outline">{stats?.environment || 'unknown'}</Badge>
          <span className="mx-2">|</span>
          <span className="font-medium">Features:</span>{' '}
          <span className="text-muted-foreground">{getEnabledFeatures(stats?.features)}</span>
        </CardContent>
      </Card>
    </div>
  );
}
