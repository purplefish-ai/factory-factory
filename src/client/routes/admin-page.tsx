import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileJson,
  FileText,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { HeaderLeftExtraSlot, useAppHeader } from '@/client/components/app-header-context';
import { Loading } from '@/client/components/loading';
import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import { useDownloadServerLog } from '@/client/hooks/use-download-server-log';
import { downloadFile } from '@/client/lib/download-file';
import { trpc } from '@/client/lib/trpc';
import { DataImportButton } from '@/components/data-import/data-import-button';
import { FactoryConfigScripts } from '@/components/factory-config-scripts';
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
import { RatchetWrenchIcon, WorkspacesBackLink } from '@/components/workspace';
import { DevServerSetupPanel } from '@/components/workspace/dev-server-setup-panel';
import {
  ApiUsageSection,
  IssueTrackingSection,
  ProcessesSection,
  ProcessesSectionSkeleton,
} from './admin/index';

function getEnabledFeatures(features?: Record<string, boolean>): string {
  if (!features) {
    return 'none';
  }
  const enabled = Object.entries(features)
    .filter(([, isEnabled]) => isEnabled)
    .map(([feature]) => feature);
  return enabled.length > 0 ? enabled.join(', ') : 'none';
}

function formatPortLabel(
  port: number | null | undefined,
  missingLabel = '(restart to detect)'
): string {
  return port != null ? String(port) : missingLabel;
}

function getFrontendPortLabel(location: Location): string {
  if (location.port) {
    const parsedPort = Number.parseInt(location.port, 10);
    if (!Number.isNaN(parsedPort)) {
      return String(parsedPort);
    }
  }

  if (location.protocol === 'http:') {
    return '80';
  }

  if (location.protocol === 'https:') {
    return '443';
  }

  return '(not available)';
}

function ProjectFactoryConfigCard({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: factoryConfig } = trpc.workspace.getFactoryConfig.useQuery({ projectId });

  const saveConfig = trpc.project.saveFactoryConfig.useMutation({
    onSuccess: () => {
      utils.workspace.getFactoryConfig.invalidate({ projectId });
      setEditPanelOpen(false);
    },
  });

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
    <div className="rounded-lg border bg-card">
      <DevServerSetupPanel
        open={editPanelOpen}
        onOpenChange={setEditPanelOpen}
        currentConfig={factoryConfig ? factoryConfig.scripts : undefined}
        onSave={(config) => {
          saveConfig.mutate({ projectId, config });
        }}
        isPending={saveConfig.isPending}
        error={saveConfig.error}
      />
      <div className="border-b bg-muted/50 px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate font-semibold text-sm">{projectName}</h3>
            {factoryConfig ? (
              <Badge variant="default" className="bg-green-600 hover:bg-green-700">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Configured
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-muted">
                <FileJson className="w-3 h-3 mr-1" />
                Not configured
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setEditPanelOpen(true)}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshConfigs.isPending}
            className="w-full gap-2 sm:w-auto"
          >
            <RefreshCw className={`w-4 h-4 ${refreshConfigs.isPending ? 'animate-spin' : ''}`} />
            Refresh Workspaces
          </Button>
        </div>
      </div>

      <div className="p-4">
        {factoryConfig ? (
          <div className="space-y-4">
            <FactoryConfigScripts factoryConfig={factoryConfig} variant="card" />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              No factory-factory.json found in this repository. Click the edit button above to
              configure workspace setup and run scripts.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function FactoryConfigSection({ projects }: { projects: Array<{ id: string; name: string }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileJson className="w-5 h-5" />
          Factory Configuration
        </CardTitle>
        <CardDescription>
          Configuration for workspace setup and run scripts (factory-factory.json)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects found.</p>
        ) : (
          <div className="space-y-4">
            {projects.map((project) => (
              <ProjectFactoryConfigCard
                key={project.id}
                projectId={project.id}
                projectName={project.name}
              />
            ))}

            <div className="text-xs text-muted-foreground space-y-1 border-t pt-4">
              <p>
                <strong>Port Allocation:</strong> Use{' '}
                <code className="bg-muted px-1 rounded">{'{port}'}</code> in run script for
                automatic port allocation
              </p>
              <p>
                <strong>Location:</strong> factory-factory.json in repository root
              </p>
            </div>
          </div>
        )}
      </CardContent>
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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
      utils.userSettings.get.invalidate();
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

  const handleIdeChange = (value: string) => {
    updateSettings.mutate({
      preferredIde: value as 'cursor' | 'vscode' | 'custom',
      customIdeCommand: value === 'custom' ? settings?.customIdeCommand || null : null,
    });
  };

  const [localCustomCommand, setLocalCustomCommand] = useState(settings?.customIdeCommand || '');

  // Sync local state when settings change externally
  useEffect(() => {
    setLocalCustomCommand(settings?.customIdeCommand || '');
  }, [settings?.customIdeCommand]);

  const saveCustomCommand = (value: string) => {
    updateSettings.mutate({
      preferredIde: 'custom',
      customIdeCommand: value || null,
    });
  };

  const handleTestCommand = () => {
    const command = settings?.customIdeCommand;
    if (!command) {
      toast.error('Please enter a custom command first');
      return;
    }
    testCommand.mutate({ customCommand: command });
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
            value={settings?.preferredIde ?? 'cursor'}
            onValueChange={handleIdeChange}
            disabled={updateSettings.isPending}
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

        {settings?.preferredIde === 'custom' && (
          <div className="space-y-2">
            <Label htmlFor="custom-command">Custom Command</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="custom-command"
                value={localCustomCommand}
                onChange={(e) => setLocalCustomCommand(e.target.value)}
                onBlur={() => saveCustomCommand(localCustomCommand)}
                placeholder="code-insiders {workspace}"
                className="font-mono text-sm flex-1"
                disabled={updateSettings.isPending}
              />
              <Button
                variant="outline"
                onClick={handleTestCommand}
                disabled={testCommand.isPending || !settings?.customIdeCommand}
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
      </CardContent>
    </Card>
  );
}

function ChatProviderDefaultsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('Chat defaults updated');
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update chat defaults: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chat Defaults</CardTitle>
          <CardDescription>Default provider for new chats</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const currentProvider = settings?.defaultSessionProvider ?? 'CLAUDE';
  const currentWorkspacePermissions = settings?.defaultWorkspacePermissions ?? 'STRICT';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Defaults</CardTitle>
        <CardDescription>
          Default provider used when a workspace defers provider selection
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="chat-default-provider">Default chat provider</Label>
        <Select
          value={currentProvider}
          onValueChange={(value) => {
            if (value === 'CLAUDE' || value === 'CODEX') {
              updateSettings.mutate({ defaultSessionProvider: value });
            }
          }}
          disabled={updateSettings.isPending}
        >
          <SelectTrigger id="chat-default-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="CLAUDE">Claude</SelectItem>
            <SelectItem value="CODEX">Codex</SelectItem>
          </SelectContent>
        </Select>
        <ProviderCliWarning provider={currentProvider} />
        <div className="space-y-2 pt-1">
          <Label htmlFor="workspace-permissions">Default permissions for new workspaces</Label>
          <Select
            value={currentWorkspacePermissions}
            onValueChange={(value) => {
              if (value === 'STRICT' || value === 'RELAXED' || value === 'YOLO') {
                updateSettings.mutate({ defaultWorkspacePermissions: value });
              }
            }}
            disabled={updateSettings.isPending}
          >
            <SelectTrigger id="workspace-permissions">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="STRICT">Strict</SelectItem>
              <SelectItem value="RELAXED">Relaxed</SelectItem>
              <SelectItem value="YOLO">YOLO</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}

function AppInfoSection() {
  const { data: serverInfo, isLoading } = trpc.admin.getServerInfo.useQuery(undefined, {
    retry: 1,
    retryDelay: 1000,
    meta: { suppressErrors: true },
  });
  const frontendPort = getFrontendPortLabel(window.location);
  const backendPort = serverInfo?.backendPort ?? null;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>App Info</CardTitle>
          <CardDescription>Repository and runtime details</CardDescription>
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
        <CardTitle>App Info</CardTitle>
        <CardDescription>Repository and runtime details</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Repository</Label>
          <a
            href="https://github.com/purplefish-ai/factory-factory"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            GitHub
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="space-y-2">
          <Label>Ports</Label>
          <div className="space-y-1 text-sm text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Frontend</span>
              <code className="rounded bg-muted px-1.5 py-0.5">{frontendPort}</code>
            </div>
            <div className="flex items-center justify-between">
              <span>Backend</span>
              <code className="rounded bg-muted px-1.5 py-0.5">{formatPortLabel(backendPort)}</code>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RatchetSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('Auto-fix settings updated');
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const triggerRatchetCheck = trpc.admin.triggerRatchetCheck.useMutation({
    onSuccess: (result) => {
      toast.success(
        `Auto-fix check completed: ${result.checked} checked, ${result.stateChanges} state changes, ${result.actionsTriggered} actions triggered`
      );
    },
    onError: (error) => {
      toast.error(`Failed to trigger auto-fix check: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
            Auto-Fix Pull Requests
          </CardTitle>
          <CardDescription>
            Automatically dispatch agents to fix CI failures and address code review comments
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const currentRatchetPermissions = settings?.ratchetPermissions ?? 'YOLO';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
          Auto-Fix Pull Requests
        </CardTitle>
        <CardDescription>
          Automatically dispatch agents to fix CI failures and address code review comments
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
          <p className="text-sm text-muted-foreground">
            When a workspace has an open pull request, Factory Factory can automatically:
          </p>
          <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5 ml-2">
            <li>Fix failing CI checks</li>
            <li>Address code review comments</li>
          </ul>
        </div>

        {/* Default for new workspaces */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="ratchet-enabled">Default for new workspaces</Label>
            <p className="text-sm text-muted-foreground">
              Enable auto-fix for workspaces created from GitHub issues
            </p>
          </div>
          <Switch
            id="ratchet-enabled"
            checked={settings?.ratchetEnabled ?? false}
            onCheckedChange={(checked) => {
              updateSettings.mutate({ ratchetEnabled: checked });
            }}
            disabled={updateSettings.isPending}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ratchet-permissions">Ratchet permission defaults</Label>
          <Select
            value={currentRatchetPermissions}
            onValueChange={(value) => {
              if (value === 'STRICT' || value === 'RELAXED' || value === 'YOLO') {
                updateSettings.mutate({ ratchetPermissions: value });
              }
            }}
            disabled={updateSettings.isPending}
          >
            <SelectTrigger id="ratchet-permissions">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="STRICT">Strict</SelectItem>
              <SelectItem value="RELAXED">Relaxed</SelectItem>
              <SelectItem value="YOLO">YOLO</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Controls the default execution mode used when Ratchet starts a fixer session.
          </p>
        </div>

        {/* Manual trigger button */}
        <div className="border-t pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <Label>Manual Check</Label>
              <p className="text-sm text-muted-foreground">
                Check all workspaces with PRs and dispatch agents if needed
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerRatchetCheck.mutate()}
              disabled={triggerRatchetCheck.isPending}
            >
              {triggerRatchetCheck.isPending ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Check All PRs Now
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Data Backup Section
// ============================================================================

function DataBackupSection() {
  const [isExporting, setIsExporting] = useState(false);
  const utils = trpc.useUtils();

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const data = await utils.admin.exportData.fetch();
      const json = JSON.stringify(data, null, 2);
      downloadFile({
        data: json,
        mimeType: 'application/json',
        fileName: `factory-factory-backup-${new Date().toISOString().split('T')[0]}.json`,
      });
      toast.success('Export completed');
    } catch (error) {
      toast.error(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileJson className="w-5 h-5" />
          Data Backup
        </CardTitle>
        <CardDescription>
          Export and import database data for backup or migration purposes
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
          <Button
            onClick={handleExport}
            disabled={isExporting}
            variant="outline"
            className="w-full sm:w-auto"
          >
            <Download className="w-4 h-4 mr-2" />
            {isExporting ? 'Exporting...' : 'Export Data'}
          </Button>
          <DataImportButton variant="outline" className="w-full sm:w-auto" />
        </div>
        <p className="text-sm text-muted-foreground">
          Export includes projects, workspaces, session metadata, and user preferences. Caches will
          be rebuilt automatically after import.
        </p>
      </CardContent>
    </Card>
  );
}

function ServerLogsSection() {
  const { download, isDownloading } = useDownloadServerLog();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Server Logs
        </CardTitle>
        <CardDescription>View and search structured server log entries</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 sm:flex-row sm:gap-3">
        <Link to="/logs">
          <Button variant="outline" className="w-full sm:w-auto">
            View Logs
          </Button>
        </Link>
        <Button
          variant="outline"
          onClick={download}
          disabled={isDownloading}
          className="w-full sm:w-auto"
        >
          <Download className="w-4 h-4 mr-2" />
          {isDownloading ? 'Downloading...' : 'Download Log File'}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function AdminDashboardPage() {
  useAppHeader({ title: 'Settings' });

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

  // Get all projects for factory config section
  const { data: projects } = trpc.project.list.useQuery();

  const resetApiStats = trpc.admin.resetApiUsageStats.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  const projectSlug = projects?.[0]?.slug;

  // Show full loading only when stats are loading (first load)
  if (isLoadingStats) {
    return <Loading message="Loading settings..." />;
  }

  return (
    <div className="h-full overflow-y-auto">
      {projectSlug && (
        <HeaderLeftExtraSlot>
          <WorkspacesBackLink projectSlug={projectSlug} />
        </HeaderLeftExtraSlot>
      )}
      <div className="space-y-6 p-3 md:p-6">
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">Environment:</span>
              <Badge variant="outline">{stats?.environment || 'unknown'}</Badge>
              <span className="font-medium sm:ml-2">Features:</span>
              <span className="text-muted-foreground break-words">
                {getEnabledFeatures(stats?.features)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Factory Configuration */}
        {projects && <FactoryConfigSection projects={projects} />}

        {projects && <IssueTrackingSection projects={projects} />}

        {/* User Settings */}
        <NotificationSettingsSection />
        <IdeSettingsSection />
        <ChatProviderDefaultsSection />
        <AppInfoSection />

        {/* Ratchet Settings (unified PR auto-progression system) */}
        <RatchetSettingsSection />

        {/* Data Backup */}
        <DataBackupSection />

        {/* Server Logs */}
        <ServerLogsSection />
      </div>
    </div>
  );
}
