import type { inferRouterOutputs } from '@trpc/server';
import { Bot, CheckCircle2, FileJson, RefreshCw, Terminal, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
import { type AppRouter, trpc } from '../../frontend/lib/trpc';

// Infer types from tRPC router outputs
type RouterOutputs = inferRouterOutputs<AppRouter>;
type ProcessesData = RouterOutputs['admin']['getActiveProcesses'];

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

function ProcessesSectionSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Active Processes
          <Skeleton className="h-5 w-16 ml-2" />
        </CardTitle>
        <CardDescription>Claude and Terminal processes currently running</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-48" />
          <div className="border rounded-md p-4 space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
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
                          {process.projectSlug ? (
                            <Link
                              to={`/projects/${process.projectSlug}/workspaces/${process.workspaceId}`}
                              className="font-medium hover:underline"
                            >
                              {process.workspaceName}
                            </Link>
                          ) : (
                            <span className="font-medium">{process.workspaceName}</span>
                          )}
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
                          {process.projectSlug ? (
                            <Link
                              to={`/projects/${process.projectSlug}/workspaces/${process.workspaceId}`}
                              className="font-medium hover:underline"
                            >
                              {process.workspaceName}
                            </Link>
                          ) : (
                            <span className="font-medium">{process.workspaceName}</span>
                          )}
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

function FactoryConfigSection({ projectId }: { projectId: string }) {
  const { data: factoryConfig } = trpc.workspace.getFactoryConfig.useQuery({ projectId });

  const refreshConfigs = trpc.workspace.refreshFactoryConfigs.useMutation({
    onSuccess: (result) => {
      if (result.errors.length > 0) {
        toast.warning(
          `Refreshed ${result.updatedCount} workspace(s), but ${result.errors.length} failed`
        );
      } else {
        toast.success(`Refreshed factory-factory.json for ${result.updatedCount} workspace(s)`);
      }
    },
    onError: (error) => {
      toast.error(`Failed to refresh configurations: ${error.message}`);
    },
  });

  const handleRefresh = () => {
    refreshConfigs.mutate({ projectId });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileJson className="w-5 h-5" />
            Factory Configuration
          </CardTitle>
          <CardDescription>
            {factoryConfig
              ? 'Configuration for workspace setup and run scripts (factory-factory.json)'
              : 'No factory-factory.json found in this repository. Create one to configure workspace setup and run scripts.'}
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshConfigs.isPending}
          className="gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${refreshConfigs.isPending ? 'animate-spin' : ''}`} />
          Refresh All Workspaces
        </Button>
      </CardHeader>
      {factoryConfig && (
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/50 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5" />
              <div className="space-y-1 flex-1">
                <p className="font-medium text-sm">Configuration Found</p>
                <p className="text-xs text-muted-foreground">
                  factory-factory.json is configured in this repository
                </p>
              </div>
            </div>

            <div className="space-y-2 pl-8">
              {factoryConfig.scripts.setup && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Setup Script</p>
                  <code className="block bg-background px-3 py-2 rounded text-xs font-mono">
                    {factoryConfig.scripts.setup}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    Runs automatically when a new workspace is created
                  </p>
                </div>
              )}

              {factoryConfig.scripts.run && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Run Script</p>
                  <code className="block bg-background px-3 py-2 rounded text-xs font-mono">
                    {factoryConfig.scripts.run}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    Available via the play button in each workspace
                  </p>
                </div>
              )}

              {factoryConfig.scripts.cleanup && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Cleanup Script</p>
                  <code className="block bg-background px-3 py-2 rounded text-xs font-mono">
                    {factoryConfig.scripts.cleanup}
                  </code>
                  <p className="text-xs text-muted-foreground">Runs when stopping the dev server</p>
                </div>
              )}
            </div>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              <strong>Location:</strong> factory-factory.json in repository root
            </p>
            <p>
              <strong>Port Allocation:</strong> Use{' '}
              <code className="bg-muted px-1 rounded">{'{port}'}</code> in run script for automatic
              port allocation
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              <strong>Note:</strong> Click "Refresh All Workspaces" to update existing workspaces
              after changing factory-factory.json
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function NotificationSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const handleToggleSound = (checked: boolean) => {
    updateSettings.mutate({ playSoundOnComplete: checked });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Notification Settings</CardTitle>
          <CardDescription>Configure notification behavior</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification Settings</CardTitle>
        <CardDescription>Configure notification behavior</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="sound-toggle">Play completion sound</Label>
            <p className="text-sm text-muted-foreground">Play a sound when a workspace finishes</p>
          </div>
          <Switch
            id="sound-toggle"
            checked={settings?.playSoundOnComplete ?? true}
            onCheckedChange={handleToggleSound}
            disabled={updateSettings.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function IdeSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('IDE settings updated');
      utils.workspace.getAvailableIdes.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const testCommand = trpc.userSettings.testCustomCommand.useMutation({
    onSuccess: () => {
      toast.success('Command executed successfully!');
    },
    onError: (error) => {
      toast.error(`Command test failed: ${error.message}`);
    },
  });

  const [preferredIde, setPreferredIde] = useState<string>('cursor');
  const [customCommand, setCustomCommand] = useState<string>('');

  // Update local state when settings load
  useEffect(() => {
    if (settings) {
      setPreferredIde(settings.preferredIde);
      setCustomCommand(settings.customIdeCommand || '');
    }
  }, [settings]);

  const handleSave = () => {
    updateSettings.mutate({
      preferredIde: preferredIde as 'cursor' | 'vscode' | 'custom',
      customIdeCommand: preferredIde === 'custom' ? customCommand : null,
    });
  };

  const handleTestCommand = () => {
    if (!customCommand) {
      toast.error('Please enter a custom command first');
      return;
    }
    testCommand.mutate({ customCommand });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>IDE Settings</CardTitle>
          <CardDescription>Configure your preferred IDE for opening workspaces</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>IDE Settings</CardTitle>
        <CardDescription>Configure your preferred IDE for opening workspaces</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ide-select">Preferred IDE</Label>
          <Select
            value={preferredIde}
            onValueChange={(value) => {
              setPreferredIde(value);
            }}
          >
            <SelectTrigger id="ide-select">
              <SelectValue placeholder="Select an IDE" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cursor">Cursor</SelectItem>
              <SelectItem value="vscode">VS Code</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {preferredIde === 'custom' && (
          <div className="space-y-2">
            <Label htmlFor="custom-command">Custom Command</Label>
            <div className="flex gap-2">
              <Input
                id="custom-command"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                placeholder="code-insiders {workspace}"
                className="font-mono text-sm flex-1"
              />
              <Button
                variant="outline"
                onClick={handleTestCommand}
                disabled={testCommand.isPending || !customCommand}
              >
                {testCommand.isPending ? 'Testing...' : 'Test'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use <code className="bg-muted px-1 py-0.5 rounded">{'{workspace}'}</code> as a
              placeholder for the workspace path. Example:{' '}
              <code className="bg-muted px-1 py-0.5 rounded">code-insiders {'{workspace}'}</code>
            </p>
          </div>
        )}

        <Button onClick={handleSave} disabled={updateSettings.isPending}>
          {updateSettings.isPending ? 'Saving...' : 'Save Settings'}
        </Button>
      </CardContent>
    </Card>
  );
}

function CiSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('CI settings updated');
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const triggerCICheck = trpc.admin.triggerCICheck.useMutation({
    onSuccess: (result) => {
      toast.success(
        `CI check completed: ${result.checked} checked, ${result.failures} failures, ${result.notified} notified`
      );
    },
    onError: (error) => {
      toast.error(`Failed to trigger CI check: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="w-5 h-5" />
            CI Settings
          </CardTitle>
          <CardDescription>Configure automatic CI failure handling</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="w-5 h-5" />
          CI Settings
        </CardTitle>
        <CardDescription>Configure automatic CI failure handling</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="auto-fix-ci">Automatically fix CI issues</Label>
            <p className="text-sm text-muted-foreground">
              When enabled, creates dedicated Claude sessions to investigate and fix CI failures
              automatically
            </p>
          </div>
          <Switch
            id="auto-fix-ci"
            checked={settings?.autoFixCiIssues ?? false}
            onCheckedChange={(checked) => {
              updateSettings.mutate({ autoFixCiIssues: checked });
            }}
            disabled={updateSettings.isPending}
          />
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Manual CI Check</Label>
              <p className="text-sm text-muted-foreground">
                Manually trigger CI status check for all workspaces with PRs
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerCICheck.mutate()}
              disabled={triggerCICheck.isPending}
            >
              {triggerCICheck.isPending ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Trigger CI Check
                </>
              )}
            </Button>
          </div>
        </div>
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

  // Get first project for factory config refresh
  const { data: projects } = trpc.project.list.useQuery();

  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  // Show full loading only when stats are loading (first load)
  if (isLoadingStats) {
    return <Loading message="Loading admin dashboard..." />;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6 p-6">
        <PageHeader title="Admin Dashboard" description="System monitoring and management" />

        <ApiUsageSection
          apiUsage={stats?.apiUsage}
          onReset={() => resetApiStats.mutate()}
          isResetting={resetApiStats.isPending}
        />

        {isLoadingProcesses ? (
          <ProcessesSectionSkeleton />
        ) : (
          <ProcessesSection processes={processes} />
        )}

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

        {/* Factory Configuration */}
        {projects && projects.length > 0 && <FactoryConfigSection projectId={projects[0].id} />}

        {/* User Settings */}
        <NotificationSettingsSection />
        <IdeSettingsSection />

        {/* CI Settings */}
        <CiSettingsSection />
      </div>
    </div>
  );
}
