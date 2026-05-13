import { Calendar, ExternalLink } from 'lucide-react';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface PeriodicTaskPanelProps {
  periodicTaskId: string;
}

export function PeriodicTaskPanel({ periodicTaskId }: PeriodicTaskPanelProps) {
  const { data: task } = trpc.periodicTask.get.useQuery(
    { id: periodicTaskId },
    { refetchInterval: 10_000 }
  );

  const { data: executions } = trpc.periodicTask.listExecutions.useQuery(
    { periodicTaskId, limit: 50 },
    { refetchInterval: 10_000 }
  );

  if (!task) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  const cadenceLabel =
    (
      {
        EVERY_MINUTE: 'Every minute',
        EVERY_FIVE_MINUTES: 'Every 5 minutes',
        DAILY: 'Daily',
        WEEKLY: 'Weekly',
        MONTHLY: 'Monthly',
      } as Record<string, string>
    )[task.cadence] ?? task.cadence;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b bg-muted/30 space-y-1">
        <div className="flex items-center gap-2">
          <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-sm truncate">{task.name}</span>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {cadenceLabel}
          </Badge>
          <Badge
            variant={task.isEnabled ? 'default' : 'secondary'}
            className="text-[10px] shrink-0"
          >
            {task.isEnabled ? 'Active' : 'Paused'}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground line-clamp-2">{task.prompt}</p>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {task.lastRunAt && <span>Last run: {new Date(task.lastRunAt).toLocaleString()}</span>}
          {task.isEnabled && <span>Next run: {new Date(task.nextRunAt).toLocaleString()}</span>}
        </div>
      </div>

      {/* Execution list */}
      <div className="flex-1 overflow-y-auto">
        {!executions || executions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            No executions yet
          </div>
        ) : (
          <div className="divide-y">
            {executions.map((exec) => (
              <ExecutionRow key={exec.id} execution={exec} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ExecutionRow({
  execution,
}: {
  execution: {
    id: string;
    status: string;
    prUrl: string | null;
    prNumber: number | null;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
  };
}) {
  const statusColors: Record<string, string> = {
    RUNNING: 'bg-yellow-500/10 text-yellow-700 border-yellow-500/30',
    PR_CREATED: 'bg-green-500/10 text-green-700 border-green-500/30',
    FAILED: 'bg-red-500/10 text-red-700 border-red-500/30',
    SKIPPED: 'bg-gray-500/10 text-gray-700 border-gray-500/30',
  };

  const statusLabel: Record<string, string> = {
    RUNNING: 'Running',
    PR_CREATED: 'PR Created',
    FAILED: 'Failed',
    SKIPPED: 'Skipped',
  };

  return (
    <div className="px-3 py-2 text-xs space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'px-1.5 py-0.5 rounded text-[10px] font-medium border',
              statusColors[execution.status] ?? 'bg-muted text-muted-foreground'
            )}
          >
            {statusLabel[execution.status] ?? execution.status}
          </span>
          <span className="text-muted-foreground">
            {new Date(execution.startedAt).toLocaleString()}
          </span>
        </div>
        {execution.prUrl && (
          <a
            href={execution.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-primary hover:underline shrink-0"
          >
            PR #{execution.prNumber}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {execution.errorMessage && (
        <p className="text-[10px] text-destructive truncate">{execution.errorMessage}</p>
      )}
    </div>
  );
}
