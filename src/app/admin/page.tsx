'use client';

import { Bot, CheckCircle2, Terminal } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
    ok: 'border-l-success',
    warning: 'border-l-warning',
    error: 'border-l-destructive',
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

function getEnabledFeatures(features?: Record<string, boolean>): string {
  if (!features) {
    return 'none';
  }
  const enabled = Object.entries(features)
    .filter(([, isEnabled]) => isEnabled)
    .map(([feature]) => feature);
  return enabled.length > 0 ? enabled.join(', ') : 'none';
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

interface ClaudeProcessInfo {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceBranch: string | null;
  name: string | null;
  workflow: string;
  model: string;
  pid: number | null;
  status: string;
  inMemory: boolean;
  memoryStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Resource monitoring
  cpuPercent: number | null;
  memoryBytes: number | null;
  idleTimeMs: number | null;
}

interface TerminalProcessInfo {
  terminalId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceBranch: string | null;
  pid: number;
  cols: number;
  rows: number;
  createdAt: Date;
  dbSessionId: string | null;
  // Resource monitoring
  cpuPercent: number | null;
  memoryBytes: number | null;
}

interface ProcessesData {
  claude: ClaudeProcessInfo[];
  terminal: TerminalProcessInfo[];
  summary: {
    totalClaude: number;
    totalTerminal: number;
    total: number;
  };
}

function getStatusBadgeVariant(
  status: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status.toUpperCase()) {
    case 'RUNNING':
      return 'default';
    case 'IDLE':
    case 'COMPLETED':
      return 'secondary';
    case 'FAILED':
      return 'destructive';
    default:
      return 'outline';
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return '-';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCpu(cpu: number | null): string {
  if (cpu === null) {
    return '-';
  }
  return `${cpu.toFixed(1)}%`;
}

function formatIdleTime(ms: number | null): string {
  if (ms === null) {
    return '-';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(0)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

function ProcessesSection({ processes }: { processes?: ProcessesData }) {
  const hasClaudeProcesses = processes?.claude && processes.claude.length > 0;
  const hasTerminalProcesses = processes?.terminal && processes.terminal.length > 0;
  const hasNoProcesses = !(hasClaudeProcesses || hasTerminalProcesses);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Active Processes
          {processes?.summary && (
            <Badge variant="secondary" className="ml-2">
              {processes.summary.total} total
            </Badge>
          )}
        </CardTitle>
        <CardDescription>Claude and Terminal processes currently running</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {hasNoProcesses && <p className="text-muted-foreground text-sm">No active processes</p>}

        {hasClaudeProcesses && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Bot className="w-4 h-4" />
              Claude Processes ({processes.claude.length})
            </h4>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Session</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {processes.claude.map((process) => (
                    <TableRow key={process.sessionId}>
                      <TableCell>
                        <div className="flex flex-col">
                          <Link
                            href={`/workspace/${process.workspaceId}`}
                            className="font-medium hover:underline"
                          >
                            {process.workspaceName}
                          </Link>
                          {process.workspaceBranch && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {process.workspaceBranch}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs font-mono text-muted-foreground">
                            {process.name || process.sessionId.slice(0, 8)}
                          </span>
                          <span className="text-xs text-muted-foreground">{process.model}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{process.workflow}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{process.pid ?? '-'}</TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs font-mono">
                          <span>CPU: {formatCpu(process.cpuPercent)}</span>
                          <span>Mem: {formatBytes(process.memoryBytes)}</span>
                          <span className="text-muted-foreground">
                            Idle: {formatIdleTime(process.idleTimeMs)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant={getStatusBadgeVariant(process.status)}>
                            {process.status}
                          </Badge>
                          {process.memoryStatus &&
                            process.memoryStatus !== process.status.toLowerCase() && (
                              <span className="text-xs text-muted-foreground">
                                ({process.memoryStatus})
                              </span>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {hasTerminalProcesses && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Terminal className="w-4 h-4" />
              Terminal Processes ({processes.terminal.length})
            </h4>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Terminal ID</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {processes.terminal.map((process) => (
                    <TableRow key={process.terminalId}>
                      <TableCell>
                        <div className="flex flex-col">
                          <Link
                            href={`/workspace/${process.workspaceId}`}
                            className="font-medium hover:underline"
                          >
                            {process.workspaceName}
                          </Link>
                          {process.workspaceBranch && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {process.workspaceBranch}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-mono text-muted-foreground">
                          {process.terminalId.slice(0, 12)}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{process.pid}</TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs font-mono">
                          <span>CPU: {formatCpu(process.cpuPercent)}</span>
                          <span>Mem: {formatBytes(process.memoryBytes)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {process.cols}x{process.rows}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(process.createdAt).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminDashboardPage() {
  const {
    data: stats,
    isLoading: isLoadingStats,
    refetch,
  } = trpc.admin.getSystemStats.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const { data: processes, isLoading: isLoadingProcesses } = trpc.admin.getActiveProcesses.useQuery(
    undefined,
    {
      refetchInterval: 5000,
    }
  );

  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  if (isLoadingStats || isLoadingProcesses) {
    return <Loading message="Loading admin dashboard..." />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Admin Dashboard" description="System monitoring and management">
        <Badge variant="outline" className="flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          Simplified Model
        </Badge>
      </PageHeader>

      <ApiUsageSection
        apiUsage={stats?.apiUsage}
        onReset={() => resetApiStats.mutate()}
        isResetting={resetApiStats.isPending}
      />

      <ConcurrencySection concurrency={stats?.concurrency} />

      <ProcessesSection processes={processes} />

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle>Admin Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 flex-wrap">
            <Button variant="secondary" asChild>
              <Link href="/admin/system">System Settings</Link>
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
