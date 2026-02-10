import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/frontend/lib/trpc';
import { forgetResumeWorkspace, isResumeWorkspace } from './resume-workspace-storage';

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

// resume workspace storage helpers live in resume-workspace-storage.ts

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
// Script Running Banner (non-blocking)
// =============================================================================

interface ScriptRunningBannerProps {
  initOutput: string | null;
  hasStartupScript: boolean;
}

export function ScriptRunningBanner({ initOutput, hasStartupScript }: ScriptRunningBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current && initOutput !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [initOutput]);

  return (
    <div className="border-b bg-muted/50 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>Running startup script...</span>
        </div>
        {hasStartupScript && initOutput && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3 mr-1" />
            ) : (
              <ChevronRight className="h-3 w-3 mr-1" />
            )}
            {expanded ? 'Hide output' : 'Show output'}
          </Button>
        )}
      </div>
      {expanded && hasStartupScript && (
        <ScrollArea
          viewportRef={scrollRef}
          className="mt-2 h-32 w-full rounded-md border bg-zinc-950"
        >
          <pre className="p-2 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
            {initOutput || <span className="text-zinc-500 italic">Waiting for output...</span>}
          </pre>
        </ScrollArea>
      )}
    </div>
  );
}

// =============================================================================
// Script Failed Banner (non-blocking)
// =============================================================================

interface ScriptFailedBannerProps {
  workspaceId: string;
  initErrorMessage: string | null;
  initOutput: string | null;
  hasStartupScript: boolean;
}

export function ScriptFailedBanner({
  workspaceId,
  initErrorMessage,
  initOutput,
  hasStartupScript,
}: ScriptFailedBannerProps) {
  const [expanded, setExpanded] = useState(false);
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

  return (
    <div className="border-b bg-destructive/10 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-3 w-3" />
          <span>Startup script failed{initErrorMessage ? `: ${initErrorMessage}` : ''}</span>
        </div>
        <div className="flex items-center gap-1">
          {hasStartupScript && initOutput && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3 mr-1" />
              ) : (
                <ChevronRight className="h-3 w-3 mr-1" />
              )}
              {expanded ? 'Hide output' : 'Show output'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
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
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Retrying...
              </>
            ) : (
              <>
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry
              </>
            )}
          </Button>
        </div>
      </div>
      {expanded && hasStartupScript && (
        <ScrollArea
          viewportRef={scrollRef}
          className="mt-2 h-32 w-full rounded-md border bg-zinc-950"
        >
          <pre className="p-2 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
            {initOutput}
          </pre>
        </ScrollArea>
      )}
    </div>
  );
}

// =============================================================================
// Archiving Overlay
// =============================================================================

export function ArchivingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-md">
      <div className="flex items-center gap-3 p-8">
        {/* Simple spinner */}
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
        {/* Grayed out text */}
        <p className="text-sm text-muted-foreground">Archiving...</p>
      </div>
    </div>
  );
}
