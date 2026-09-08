import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  FileCodeIcon,
  PencilIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FactoryConfigScripts } from '@/client/components/factory-config-scripts';
import { DevServerSetupPanel } from '@/client/features/workspace/dev-server-setup-panel';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function ProjectFactoryConfigCard({
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
                <CheckCircleIcon className="w-3 h-3 mr-1" />
                Configured
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-muted">
                <FileCodeIcon className="w-3 h-3 mr-1" />
                Not configured
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setEditPanelOpen(true)}
            >
              <PencilIcon className="w-3.5 h-3.5" />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshConfigs.isPending}
            className="w-full gap-2 sm:w-auto"
          >
            <ArrowsClockwiseIcon
              className={`w-4 h-4 ${refreshConfigs.isPending ? 'animate-spin' : ''}`}
            />
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
