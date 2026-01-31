import { Loader2, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/frontend/lib/trpc';

interface RunScriptButtonProps {
  workspaceId: string;
}

export function RunScriptButton({ workspaceId }: RunScriptButtonProps) {
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
    },
  });

  const stopScript = trpc.workspace.stopRunScript.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  // Don't show button if no run script configured
  if (!status?.hasRunScript) {
    return null;
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
    return 'Start dev server';
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
