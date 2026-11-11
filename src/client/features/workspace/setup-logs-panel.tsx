import { StatusDot } from '@/client/components/status-indicators';
import { useFollowOutput } from '@/client/hooks/use-follow-output';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { cn } from '@/lib/utils';

interface SetupLogsPanelProps {
  workspaceId: string;
  className?: string;
}

export function SetupLogsPanel({ workspaceId, className }: SetupLogsPanelProps) {
  const followOutputRef = useFollowOutput();

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
          <StatusDot tone={status === 'FAILED' ? 'danger' : 'working'} size="xs" />
          <span>Startup script: {statusLabel}</span>
        </div>
      )}
      <div
        ref={followOutputRef}
        className="flex-1 overflow-y-auto overflow-x-auto scroll-smooth font-mono text-xs p-4 bg-black text-white"
      >
        <pre className="whitespace-pre-wrap break-words">{output || emptyText}</pre>
      </div>
    </div>
  );
}
