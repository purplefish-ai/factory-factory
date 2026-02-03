import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';
import { forgetResumeWorkspace } from './list';

// =============================================================================
// Workspace Initialization Overlay
// =============================================================================

interface InitializationOverlayProps {
  workspaceId: string;
  status: 'NEW' | 'PROVISIONING' | 'READY' | 'FAILED' | 'ARCHIVED';
  initErrorMessage: string | null;
  initOutput: string | null;
  hasStartupScript: boolean;
}

const RESUME_WORKSPACE_IDS_KEY = 'ff_resume_workspace_ids';

function isResumeWorkspace(workspaceId: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const raw = window.localStorage.getItem(RESUME_WORKSPACE_IDS_KEY);
    const existing = raw ? (JSON.parse(raw) as string[]) : [];
    return existing.includes(workspaceId);
  } catch {
    return false;
  }
}

export function InitializationOverlay({
  workspaceId,
  status,
  initErrorMessage,
  initOutput,
  hasStartupScript,
}: InitializationOverlayProps) {
  const utils = trpc.useUtils();
  const scrollRef = useRef<HTMLDivElement>(null);

  const retryInit = trpc.workspace.retryInit.useMutation({
    onSuccess: () => {
      utils.workspace.getInitStatus.invalidate({ id: workspaceId });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (scrollRef.current && initOutput !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [initOutput]);

  useEffect(() => {
    if (status === 'READY' || status === 'ARCHIVED') {
      forgetResumeWorkspace(workspaceId);
    }
  }, [status, workspaceId]);

  const isFailed = status === 'FAILED';
  const isProvisioning = status === 'PROVISIONING';
  const showLogs = hasStartupScript && (isProvisioning || isFailed);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-8 max-w-2xl w-full text-center">
        {isFailed ? (
          <>
            <div className="rounded-full bg-destructive/10 p-3">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Workspace Setup Failed</h2>
              <p className="text-sm text-muted-foreground">
                {initErrorMessage || 'An error occurred while setting up this workspace.'}
              </p>
            </div>
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

        {/* Startup Script Output */}
        {showLogs && (
          <div className="w-full mt-4">
            <ScrollArea
              viewportRef={scrollRef}
              className="h-48 w-full rounded-md border bg-zinc-950 text-left"
            >
              <pre className="p-3 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
                {initOutput || <span className="text-zinc-500 italic">Waiting for output...</span>}
              </pre>
            </ScrollArea>
          </div>
        )}

        {isFailed && (
          <Button
            onClick={() =>
              retryInit.mutate({
                id: workspaceId,
                useExistingBranch: isResumeWorkspace(workspaceId) || undefined,
              })
            }
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
