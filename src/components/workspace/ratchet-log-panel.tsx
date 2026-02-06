import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';
import { getRatchetStateLabel } from './ratchet-state';

interface RatchetLogPanelProps {
  workspaceId: string;
  className?: string;
}

const ACTION_COLORS: Record<string, string> = {
  TRIGGERED_FIXER: 'text-blue-400',
  FIXER_ACTIVE: 'text-yellow-400',
  NOTIFIED_ACTIVE_FIXER: 'text-yellow-400',
  DISABLED: 'text-zinc-500',
  WAITING: 'text-zinc-500',
  READY_FOR_MERGE: 'text-green-400',
  AUTO_MERGED: 'text-green-400',
  COMPLETED: 'text-green-400',
  ERROR: 'text-red-400',
};

function formatTime(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function tryParseJson(str: string | null | undefined): Record<string, unknown> | null {
  if (!str) {
    return null;
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export function RatchetLogPanel({ workspaceId, className }: RatchetLogPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { data: entries, isLoading } = trpc.ratchetAuditLog.listByWorkspace.useQuery(
    { workspaceId, limit: 200 },
    { refetchInterval: 60_000, staleTime: 30_000 }
  );

  // Auto-scroll to top when new entries arrive (they're reverse-chronological)
  useEffect(() => {
    if (containerRef.current && entries?.length) {
      containerRef.current.scrollTop = 0;
    }
  }, [entries?.length]);

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full bg-black', className)}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center h-full bg-black text-zinc-500 text-sm',
          className
        )}
      >
        No ratchet activity yet
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn('h-full overflow-y-auto font-mono text-xs p-2 bg-black text-white', className)}
    >
      {entries.map((entry) => {
        const actionDetail = tryParseJson(entry.actionDetail);
        const prSnapshot = tryParseJson(entry.prSnapshot);
        const stateChanged = entry.previousState !== entry.newState;
        const actionColor = ACTION_COLORS[entry.action] ?? 'text-zinc-400';

        return (
          <div key={entry.id} className="py-0.5 border-b border-zinc-900 last:border-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-zinc-600">{formatDate(entry.timestamp)}</span>
              <span className="text-zinc-500">{formatTime(entry.timestamp)}</span>

              {stateChanged ? (
                <span>
                  <span className="text-zinc-400">{getRatchetStateLabel(entry.previousState)}</span>
                  <span className="text-zinc-600"> → </span>
                  <span className="text-white">{getRatchetStateLabel(entry.newState)}</span>
                </span>
              ) : (
                <span className="text-zinc-400">{getRatchetStateLabel(entry.newState)}</span>
              )}

              <span className={actionColor}>{entry.action}</span>

              {actionDetail && <ActionDetailInline detail={actionDetail} />}
            </div>

            {prSnapshot && entry.action !== 'WAITING' && (
              <div className="ml-[4.5rem] text-zinc-600 mt-0.5">
                PR#{entry.prNumber}
                {prSnapshot.ciStatus ? ` ci:${String(prSnapshot.ciStatus)}` : null}
                {prSnapshot.mergeStateStatus
                  ? ` merge:${String(prSnapshot.mergeStateStatus)}`
                  : null}
                {(prSnapshot.newReviewCommentCount as number) > 0 &&
                  ` review-comments:${prSnapshot.newReviewCommentCount}`}
                {(prSnapshot.newPRCommentCount as number) > 0 &&
                  ` pr-comments:${prSnapshot.newPRCommentCount}`}
                {(prSnapshot.failedCheckNames as string[])?.length > 0 &&
                  ` failed:[${(prSnapshot.failedCheckNames as string[]).join(', ')}]`}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActionDetailInline({ detail }: { detail: Record<string, unknown> }) {
  const parts: string[] = [];
  if (detail.fixerType) {
    parts.push(`fixer:${detail.fixerType}`);
  }
  if (detail.sessionId) {
    parts.push(`session:${(detail.sessionId as string).slice(0, 8)}`);
  }
  if (detail.reason) {
    parts.push(`${detail.reason}`);
  }
  if (detail.error) {
    parts.push(`${detail.error}`);
  }
  if (detail.issue) {
    parts.push(`${detail.issue}`);
  }

  if (parts.length === 0) {
    return null;
  }
  return <span className="text-zinc-600">{parts.join(' ')}</span>;
}
