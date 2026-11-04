import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { PencilIcon } from '@phosphor-icons/react/dist/csr/Pencil';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FactoryConfigScripts } from '@/client/components/factory-config-scripts';
import { Loading } from '@/client/components/loading';
import { DevServerSetupPanel } from '@/client/features/workspace/dev-server-setup-panel';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

export function ProjectFactoryConfigCard({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const utils = trpc.useUtils();
  const {
    data: factoryConfig,
    isPending,
    isSuccess,
    isError,
    error: configError,
    refetch,
  } = trpc.workspace.getFactoryConfig.useQuery({ projectId });

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
    <Card>
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
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileCodeIcon className="h-5 w-5" />
          Factory configuration
        </CardTitle>
        <CardDescription className="[overflow-wrap:anywhere]">
          Workspace setup and run scripts for {projectName} (factory-factory.json)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {isSuccess &&
              (factoryConfig ? (
                <Badge variant="success">
                  <CheckCircleIcon className="w-3 h-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-muted">
                  <FileCodeIcon className="w-3 h-3 mr-1" />
                  Not configured
                </Badge>
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
            disabled={refreshConfigs.isPending}
            className="w-full gap-2 sm:w-auto"
          >
            {refreshConfigs.isPending ? (
              <Spinner className="w-4 h-4" aria-hidden="true" />
            ) : (
              <ArrowsClockwiseIcon className="w-4 h-4" />
            )}
            Refresh Workspaces
          </Button>
        </div>

        <div>
          {isPending && <Loading size="compact" message="Loading configuration…" />}
          {isError && (
            <div role="alert" className="space-y-3">
              <p className="text-sm text-destructive">
                Couldn't load configuration. {configError.message}
              </p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          )}
          {isSuccess &&
            (factoryConfig ? (
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
            ))}
        </div>
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
      </CardContent>
    </Card>
  );
}
