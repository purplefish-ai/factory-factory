import { FileJson, Loader2, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/frontend/lib/trpc';
import { useWorkspacePanel } from './workspace-panel-context';

interface RunScriptButtonProps {
  workspaceId: string;
  showPlaceholder?: boolean;
}

export function RunScriptButton({ workspaceId, showPlaceholder = true }: RunScriptButtonProps) {
  const { setActiveBottomTab, setRightPanelVisible } = useWorkspacePanel();

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

  // Show placeholder button if no run script configured
  if (!status?.hasRunScript) {
    if (!showPlaceholder) {
      return null;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 opacity-40 cursor-help" disabled>
            <Play className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-2">
            <p className="font-medium">No dev server configured</p>
            <p className="text-xs">
              To enable the play button, create a{' '}
              <code className="bg-muted px-1 rounded">factory-factory.json</code> file in your
              project root:
            </p>
            <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
              {`{
  "scripts": {
    "run": "npm run dev"
  }
}`}
            </pre>
            <p className="text-xs text-muted-foreground">
              <FileJson className="h-3 w-3 inline mr-1" />
              Use the quick actions menu to generate this file
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
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
