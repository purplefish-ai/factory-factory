import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { trpc } from '@/frontend/lib/trpc';
import { forgetResumeWorkspace, isResumeWorkspace } from './resume-workspace-storage';

// =============================================================================
// Workspace Initialization Overlay
// =============================================================================
//
// NOTE: This overlay is now only shown during the very brief NEW state before
// PROVISIONING begins. Once PROVISIONING starts, the Init Logs tab shows
// progress and the UI is fully interactive.
//
// For FAILED state, a non-blocking error banner is shown instead (see
// InitFailedBanner component).
// =============================================================================

interface InitializationOverlayProps {
  workspaceId: string;
  status: 'NEW' | 'PROVISIONING' | 'READY' | 'FAILED' | 'ARCHIVED';
}

// resume workspace storage helpers live in resume-workspace-storage.ts

export function InitializationOverlay({ workspaceId, status }: InitializationOverlayProps) {
  useEffect(() => {
    if (status === 'READY' || status === 'ARCHIVED') {
      forgetResumeWorkspace(workspaceId);
    }
  }, [status, workspaceId]);

  // Only show overlay during the brief NEW state before provisioning starts
  // PROVISIONING: handled by Init Logs tab (non-blocking)
  // FAILED: handled by InitFailedBanner (non-blocking)
  // READY/ARCHIVED: no overlay needed
  if (status !== 'NEW') {
    return null;
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-8 max-w-2xl w-full text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Creating workspace...</h2>
          <p className="text-sm text-muted-foreground">
            Preparing your workspace. This will only take a moment.
          </p>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Init Failed Banner (Non-blocking)
// =============================================================================

interface InitFailedBannerProps {
  workspaceId: string;
  errorMessage: string | null;
}

export function InitFailedBanner({ workspaceId, errorMessage }: InitFailedBannerProps) {
  const utils = trpc.useUtils();

  const retryInit = trpc.workspace.retryInit.useMutation({
    onSuccess: () => {
      utils.workspace.getInitStatus.invalidate({ id: workspaceId });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  return (
    <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
        <span className="text-sm text-red-400 truncate">
          Setup failed{errorMessage ? `: ${errorMessage}` : ''}. You can still use this workspace.
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          retryInit.mutate({
            id: workspaceId,
            useExistingBranch: isResumeWorkspace(workspaceId) || undefined,
          })
        }
        disabled={retryInit.isPending}
        className="flex-shrink-0"
      >
        {retryInit.isPending ? (
          <>
            <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
            Retrying...
          </>
        ) : (
          <>
            <RefreshCw className="h-3 w-3 mr-1.5" />
            Retry
          </>
        )}
      </Button>
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
