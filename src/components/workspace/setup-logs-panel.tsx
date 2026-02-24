import { useRef } from 'react';
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
          : 1000;
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

  const statusLabel =
    status === 'PROVISIONING' ? 'Running...' : status === 'FAILED' ? 'Failed' : '';
  const showStatusBanner = status === 'PROVISIONING' || status === 'FAILED';

  return (
    <div className={cn('h-full bg-background flex flex-col', className)}>
      {showStatusBanner && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b text-xs text-muted-foreground">
          {status === 'PROVISIONING' && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
          )}
          {status === 'FAILED' && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
          <span>Startup script: {statusLabel}</span>
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-auto font-mono text-xs p-4 bg-black text-white"
      >
        <pre className="whitespace-pre-wrap break-words">{output || 'No setup logs yet.'}</pre>
      </div>
    </div>
  );
}
