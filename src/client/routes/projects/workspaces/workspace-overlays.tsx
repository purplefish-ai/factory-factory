import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { trpc } from '@/frontend/lib/trpc';

// =============================================================================
// Workspace Initialization Overlay
// =============================================================================

import type { WorkspaceStatus } from '@prisma-gen/browser';

interface InitializationOverlayProps {
  workspaceId: string;
  status: WorkspaceStatus;
  errorMessage: string | null;
  hasStartupScript: boolean;
}

export function InitializationOverlay({
  workspaceId,
  status,
  errorMessage,
  hasStartupScript,
}: InitializationOverlayProps) {
  const utils = trpc.useUtils();

  const retryInit = trpc.workspace.retryInit.useMutation({
    onSuccess: () => {
      utils.workspace.getInitStatus.invalidate({ id: workspaceId });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const isFailed = status === 'FAILED';
  const isProvisioning = status === 'PROVISIONING';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
        {isFailed ? (
          <>
            <div className="rounded-full bg-destructive/10 p-3">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Workspace Setup Failed</h2>
              <p className="text-sm text-muted-foreground">
                {errorMessage || 'An error occurred while setting up this workspace.'}
              </p>
            </div>
            <Button
              onClick={() => retryInit.mutate({ id: workspaceId })}
              disabled={retryInit.isPending}
            >
              {retryInit.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Retrying...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry Setup
                </>
              )}
            </Button>
          </>
        ) : (
          <>
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Setting up workspace...</h2>
              <p className="text-sm text-muted-foreground">
                {isProvisioning && hasStartupScript
                  ? 'Running startup script. This may take a few minutes.'
                  : 'Creating git worktree and preparing your workspace.'}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Archiving Overlay
// =============================================================================

export function ArchivingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Archiving workspace...</h2>
          <p className="text-sm text-muted-foreground">
            Cleaning up worktree and archiving this workspace.
          </p>
        </div>
      </div>
    </div>
  );
}
