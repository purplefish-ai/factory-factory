import { Loader2, Play, Square } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/frontend/lib/trpc';
import { DevServerSetupPanel } from './dev-server-setup-panel';
import { useWorkspacePanel } from './workspace-panel-context';

interface RunScriptButtonProps {
  workspaceId: string;
}

export function RunScriptButton({ workspaceId }: RunScriptButtonProps) {
  const { setActiveBottomTab, setRightPanelVisible } = useWorkspacePanel();
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);

  // Query run script status (React Query automatically deduplicates with same key)
  const { data: status, refetch } = trpc.workspace.getRunScriptStatus.useQuery(
    { workspaceId },
    {
      refetchInterval: (query) => {
        // Poll more frequently when running
        return query.state.data?.status === 'RUNNING' ? 2000 : 5000;
      },
    }
  );

  // Mutations
  const startScript = trpc.workspace.startRunScript.useMutation({
    onSuccess: () => {
      refetch();
      setActiveBottomTab('dev-logs');
      setRightPanelVisible(true);
    },
  });

  const stopScript = trpc.workspace.stopRunScript.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  // Show setup button if no run script configured
  if (!status?.hasRunScript) {
    return (
      <>
        <DevServerSetupPanel
          open={setupDialogOpen}
          onOpenChange={setSetupDialogOpen}
          workspaceId={workspaceId}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setSetupDialogOpen(true)}
            >
              <Play className="h-4 w-4 text-green-600 fill-green-600" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Setup dev server</TooltipContent>
        </Tooltip>
      </>
    );
  }

  const isRunning = status.status === 'RUNNING';
  const isLoading = startScript.isPending || stopScript.isPending;

  const handleClick = () => {
    if (isRunning) {
      stopScript.mutate({ workspaceId });
    } else {
      startScript.mutate({ workspaceId });
    }
  };

  const tooltipText = (() => {
    if (isLoading) {
      return 'Processing...';
    }
    if (isRunning) {
      return status.port ? `Stop dev server (port ${status.port})` : 'Stop dev server';
    }
    return status.runScriptCommand
      ? `Start dev server: ${status.runScriptCommand}`
      : 'Start dev server';
  })();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleClick}
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isRunning ? (
            <Square className="h-4 w-4 text-destructive fill-destructive" />
          ) : (
            <Play className="h-4 w-4 text-green-600 fill-green-600" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
