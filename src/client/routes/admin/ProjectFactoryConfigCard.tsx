import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { PencilIcon } from '@phosphor-icons/react/dist/csr/Pencil';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FactoryConfigScripts } from '@/client/components/factory-config-scripts';
import { QueryErrorState } from '@/client/components/query-error-state';
import { QueryState } from '@/client/components/query-state';
import { StatusChip } from '@/client/components/status-indicators';
import { DevServerSetupPanel } from '@/client/features/workspace/dev-server-setup-panel';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { SettingsSection } from './settings-section';

export function ProjectFactoryConfigCard({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const utils = trpc.useUtils();
  const configQuery = trpc.workspace.getFactoryConfig.useQuery({ projectId });
  const { data: factoryConfig, isSuccess } = configQuery;

  useEffect(() => {
    if (!isSuccess) {
      setEditPanelOpen(false);
    }
  }, [isSuccess]);

  const saveConfig = trpc.project.saveFactoryConfig.useMutation({
    onSuccess: () => {
      runInBackground(
        utils.workspace.getFactoryConfig.invalidate({ projectId }),
        "Couldn't refresh data."
      );
      setEditPanelOpen(false);
    },
    onError: (error) => {
      toast.error(`Couldn't save configuration. ${error.message}`);
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
      toast.error(`Couldn't refresh configurations. ${error.message}`);
    },
  });

  const handleRefresh = () => {
    refreshConfigs.mutate({ projectId });
  };

  return (
    <>
      {isSuccess && (
        <DevServerSetupPanel
          open={editPanelOpen}
          onOpenChange={setEditPanelOpen}
          currentConfig={factoryConfig ? factoryConfig.scripts : undefined}
          onSave={(config) => {
            if (isSuccess) {
              saveConfig.mutate({ projectId, config });
            }
          }}
          isPending={saveConfig.isPending}
          error={saveConfig.error}
        />
      )}
      <SettingsSection
        title="Factory configuration"
        icon={<FileCodeIcon className="h-5 w-5" />}
        description={
          <span className="[overflow-wrap:anywhere]">
            Workspace setup and run scripts for {projectName} (factory-factory.json)
          </span>
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {isSuccess &&
              (factoryConfig ? (
                <StatusChip tone="success" icon={CheckCircleIcon} size="md">
                  Configured
                </StatusChip>
              ) : (
                <StatusChip tone="neutral" icon={FileCodeIcon} size="md">
                  Not configured
                </StatusChip>
              ))}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Edit factory configuration"
              disabled={!isSuccess}
              onClick={() => setEditPanelOpen(true)}
            >
              <PencilIcon className="w-3.5 h-3.5" />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            pending={refreshConfigs.isPending}
            className="w-full gap-2 sm:w-auto"
          >
            <ArrowsClockwiseIcon className="w-4 h-4" />
            Refresh Workspaces
          </Button>
        </div>

        {configQuery.isError && configQuery.data !== undefined ? (
          // Cached scripts stay visible, but editing waits for a fresh read.
          <QueryErrorState
            title="Couldn't refresh configuration"
            error={configQuery.error}
            onRetry={() => void configQuery.refetch()}
            isRetrying={configQuery.isFetching}
          />
        ) : null}
        <QueryState
          query={configQuery}
          errorTitle="Couldn't load configuration"
          loadingMessage="Loading configuration…"
          size="compact"
        >
          {(config) =>
            config ? (
              <FactoryConfigScripts factoryConfig={config} variant="card" />
            ) : (
              <p className="text-sm text-muted-foreground">
                No factory-factory.json found in this repository. Click the edit button above to
                configure workspace setup and run scripts.
              </p>
            )
          }
        </QueryState>
        <div className="space-y-1 border-t pt-4 text-xs text-muted-foreground">
          <p>
            <strong>Port allocation:</strong> Use{' '}
            <code className="rounded bg-muted px-1">{'{port}'}</code> in run scripts for automatic
            port allocation.
          </p>
          <p>
            <strong>Location:</strong> factory-factory.json in repository root
          </p>
        </div>
      </SettingsSection>
    </>
  );
}
