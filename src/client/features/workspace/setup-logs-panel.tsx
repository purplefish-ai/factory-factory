import { useRef } from 'react';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { cn } from '@/lib/utils';

interface SetupLogsPanelProps {
  workspaceId: string;
  className?: string;
}

export function SetupLogsPanel({ workspaceId, className }: SetupLogsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevOutputLenRef = useRef(0);

  const { data: initStatus } = trpc.workspace.getInitStatus.useQuery(
    { id: workspaceId },
    {
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === 'READY' ||
          status === 'FAILED' ||
          status === 'ARCHIVING' ||
          status === 'ARCHIVED'
          ? false
          : POLL_INTERVAL_MS.progress;
      },
    }
  );

  const output = initStatus?.initOutput ?? '';
  const status = initStatus?.status;

  // Auto-scroll to bottom when output grows (during render, not in effect)
  if (output.length > prevOutputLenRef.current) {
    prevOutputLenRef.current = output.length;
    // Schedule scroll after render
    requestAnimationFrame(() => {
      containerRef.current?.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  }

  const statusLabel = status === 'PROVISIONING' ? 'Running…' : status === 'FAILED' ? 'Failed' : '';
  const showStatusBanner = status === 'PROVISIONING' || status === 'FAILED';
  // Archive drops the setup log, keeping only the end of a failed setup's log.
  const archived = status === 'ARCHIVED';
  const emptyText = archived
    ? 'Setup logs are not kept for archived workspaces.'
    : 'No setup logs yet.';

  return (
    <div className={cn('h-full bg-background flex flex-col', className)}>
      {archived && output && (
        <div className="px-4 py-1.5 border-b text-xs text-muted-foreground">
          Archived workspaces keep only the end of a failed setup log.
        </div>
      )}
      {showStatusBanner && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b text-xs text-muted-foreground">
          {status === 'PROVISIONING' && (
            <span className="w-1.5 h-1.5 rounded-full bg-running animate-pulse motion-reduce:animate-none" />
          )}
          {status === 'FAILED' && <span className="w-1.5 h-1.5 rounded-full bg-destructive" />}
          <span>Startup script: {statusLabel}</span>
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-auto font-mono text-xs p-4 bg-black text-white"
      >
        <pre className="whitespace-pre-wrap break-words">{output || emptyText}</pre>
      </div>
    </div>
  );
}
