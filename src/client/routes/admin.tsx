import { Download, FileJson, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { RatchetWrenchIcon } from '@/components/workspace';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { trpc } from '../../frontend/lib/trpc';
import { ApiUsageSection, ProcessesSection, ProcessesSectionSkeleton } from './admin/index';

function getEnabledFeatures(features?: Record<string, boolean>): string {
  if (!features) {
    return 'none';
  }
  const enabled = Object.entries(features)
    .filter(([, isEnabled]) => isEnabled)
    .map(([feature]) => feature);
  return enabled.length > 0 ? enabled.join(', ') : 'none';
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
          <FactoryConfigScripts factoryConfig={factoryConfig} variant="card" />

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

function RatchetSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('Ratchet settings updated');
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const triggerRatchetCheck = trpc.admin.triggerRatchetCheck.useMutation({
    onSuccess: (result) => {
      toast.success(
        `Ratchet check completed: ${result.checked} checked, ${result.stateChanges} state changes, ${result.actionsTriggered} actions triggered`
      );
    },
    onError: (error) => {
      toast.error(`Failed to trigger ratchet check: ${error.message}`);
    },
  });

  const [allowedReviewers, setAllowedReviewers] = useState<string>('');

  // Update local state when settings load
  useEffect(() => {
    if (settings) {
      const reviewers = (settings.ratchetAllowedReviewers as string[]) ?? [];
      setAllowedReviewers(reviewers.join(', '));
    }
  }, [settings]);

  const handleSaveAllowedReviewers = () => {
    const reviewers = allowedReviewers
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    updateSettings.mutate({
      ratchetAllowedReviewers: reviewers.length > 0 ? reviewers : null,
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
            Ratchet (PR Auto-Progression)
          </CardTitle>
          <CardDescription>
            Automatically progress PRs toward merge by fixing issues
          </CardDescription>
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
          <RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />
          Ratchet (PR Auto-Progression)
        </CardTitle>
        <CardDescription>
          Configure ratchet defaults and automation behavior for PR progression
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
          <p className="text-sm font-medium">How ratcheting works</p>
          <p className="text-sm text-muted-foreground">
            Ratchet monitors workspaces that have PRs and reacts to the current PR state.
          </p>
          <p className="text-sm text-muted-foreground">
            If CI fails, conflicts appear, or review comments are left, ratchet can open a fix
            session, apply changes, and push updates.
          </p>
          <p className="text-sm text-muted-foreground">
            This runs repeatedly until the PR is clean, approved, and ready to merge (or merged
            automatically if enabled).
          </p>
        </div>

        {/* Default for all new workspaces */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="ratchet-enabled">Default for all new workspaces</Label>
            <p className="text-sm text-muted-foreground">
              Sets the initial ratchet state for new workspaces created manually, from GitHub
              issues, or from existing branches
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

        {/* Individual toggles */}
        <div className="space-y-4 border-t pt-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="ratchet-ci">Auto-fix CI failures</Label>
              <p className="text-sm text-muted-foreground">
                Automatically investigate and fix failing CI checks
              </p>
            </div>
            <Switch
              id="ratchet-ci"
              checked={settings?.ratchetAutoFixCi ?? true}
              onCheckedChange={(checked) => {
                updateSettings.mutate({ ratchetAutoFixCi: checked });
              }}
              disabled={updateSettings.isPending}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="ratchet-reviews">Auto-address review comments</Label>
              <p className="text-sm text-muted-foreground">
                Automatically implement changes requested by reviewers
              </p>
            </div>
            <Switch
              id="ratchet-reviews"
              checked={settings?.ratchetAutoFixReviews ?? true}
              onCheckedChange={(checked) => {
                updateSettings.mutate({ ratchetAutoFixReviews: checked });
              }}
              disabled={updateSettings.isPending}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="ratchet-merge">Auto-merge when ready</Label>
              <p className="text-sm text-muted-foreground">
                Automatically merge PRs when all checks pass and reviews are approved
              </p>
            </div>
            <Switch
              id="ratchet-merge"
              checked={settings?.ratchetAutoMerge ?? false}
              onCheckedChange={(checked) => {
                updateSettings.mutate({ ratchetAutoMerge: checked });
              }}
              disabled={updateSettings.isPending}
            />
          </div>
        </div>

        {/* Allowed reviewers input */}
        <div className="space-y-2 border-t pt-4">
          <Label htmlFor="ratchet-reviewers">Allowed Reviewers (GitHub usernames)</Label>
          <p className="text-sm text-muted-foreground">
            Only auto-fix comments from these reviewers. Leave empty to process all reviewers.
          </p>
          <div className="flex gap-2">
            <Input
              id="ratchet-reviewers"
              placeholder="reviewer1, reviewer2"
              value={allowedReviewers}
              onChange={(e) => setAllowedReviewers(e.target.value)}
              className="flex-1"
            />
            <Button
              variant="outline"
              onClick={handleSaveAllowedReviewers}
              disabled={updateSettings.isPending}
            >
              Save
            </Button>
          </div>
        </div>

        {/* Manual trigger button */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Manual Ratchet Check</Label>
              <p className="text-sm text-muted-foreground">
                Manually trigger ratchet check for all workspaces with PRs
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
                  Trigger Ratchet Check
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
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `factory-factory-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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
        <div className="flex gap-4">
          <Button onClick={handleExport} disabled={isExporting} variant="outline">
            <Download className="w-4 h-4 mr-2" />
            {isExporting ? 'Exporting...' : 'Export Data'}
          </Button>
          <DataImportButton variant="outline" />
        </div>
        <p className="text-sm text-muted-foreground">
          Export includes projects, workspaces, session metadata, and user preferences. Caches will
          be rebuilt automatically after import.
        </p>
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
        {/* biome-ignore lint/style/noNonNullAssertion: length > 0 checked */}
        {projects && projects.length > 0 && <FactoryConfigSection projectId={projects[0]!.id} />}

        {/* User Settings */}
        <NotificationSettingsSection />
        <IdeSettingsSection />

        {/* Ratchet Settings (unified PR auto-progression system) */}
        <RatchetSettingsSection />

        {/* Data Backup */}
        <DataBackupSection />
      </div>
    </div>
  );
}
