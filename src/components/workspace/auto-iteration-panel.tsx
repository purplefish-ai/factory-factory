import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  OctagonX,
  Pause,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface AutoIterationPanelProps {
  workspaceId: string;
}

interface IterationProgress {
  currentIteration: number;
  baselineMetricSummary: string;
  currentMetricSummary: string;
  acceptedCount: number;
  rejectedRegressionCount: number;
  rejectedCritiqueCount: number;
  crashedCount: number;
  sessionRecycleCount: number;
  startedAt: string;
  lastIterationAt: string | null;
}

interface IterationConfig {
  testCommand: string;
  targetDescription: string;
  maxIterations: number;
  testTimeoutSeconds: number;
  sessionRecycleInterval: number;
}

interface LogbookEntry {
  iteration: number;
  startedAt: string;
  completedAt: string;
  status: 'accepted' | 'rejected_regression' | 'rejected_critique' | 'crashed';
  changeDescription: string;
  commitSha: string;
  commitReverted: boolean;
  metricBefore: string;
  metricAfter: string | null;
  testOutput: string;
  metricImproved: boolean | null;
  crashError: string | null;
  fixAttempts: number;
  critiqueNotes: string | null;
  critiqueApproved: boolean | null;
}

const STATUS_LABELS: Record<string, string> = {
  IDLE: 'Idle',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  MAX_ITERATIONS: 'Max iterations reached',
  STOPPED: 'Stopped',
  FAILED: 'Failed',
};

const ENTRY_STATUS_CONFIG: Record<
  LogbookEntry['status'],
  { icon: typeof CheckCircle; label: string; color: string }
> = {
  accepted: { icon: CheckCircle, label: 'Accepted', color: 'text-green-500' },
  rejected_regression: { icon: XCircle, label: 'Rejected (regression)', color: 'text-orange-500' },
  rejected_critique: { icon: XCircle, label: 'Rejected (critique)', color: 'text-amber-500' },
  crashed: { icon: OctagonX, label: 'Crashed', color: 'text-red-500' },
};

function IterationEntry({ entry }: { entry: LogbookEntry }) {
  const [expanded, setExpanded] = useState(false);
  const config = ENTRY_STATUS_CONFIG[entry.status];
  const Icon = config.icon;

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        className="w-full flex items-start gap-2 p-2 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <Icon className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', config.color)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-medium">#{entry.iteration}</span>
            <span className={cn('text-xs', config.color)}>{config.label}</span>
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {entry.changeDescription.slice(0, 120)}
          </p>
        </div>
      </button>
      {expanded && (
        <div className="px-8 pb-2 space-y-1.5 text-xs">
          {entry.metricBefore && entry.metricAfter && (
            <div className="text-muted-foreground">
              <span>{entry.metricBefore}</span>
              <span className="mx-1">&rarr;</span>
              <span className={entry.metricImproved ? 'text-green-500' : 'text-orange-500'}>
                {entry.metricAfter}
              </span>
            </div>
          )}
          {entry.commitSha && (
            <div className="text-muted-foreground font-mono">
              {entry.commitSha.slice(0, 8)}
              {entry.commitReverted && <span className="ml-1 text-orange-500">(reverted)</span>}
            </div>
          )}
          {entry.critiqueNotes && (
            <div className="text-muted-foreground italic">
              Critique: {entry.critiqueNotes.slice(0, 300)}
            </div>
          )}
          {entry.crashError && (
            <div className="text-red-500 font-mono text-[11px]">
              {entry.crashError.slice(0, 200)}
            </div>
          )}
          {entry.changeDescription && (
            <div className="text-muted-foreground">{entry.changeDescription.slice(0, 500)}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressSummary({
  progress,
  config,
  status,
}: {
  progress: IterationProgress;
  config: IterationConfig;
  status: string;
}) {
  const maxLabel = config.maxIterations === 0 ? '∞' : String(config.maxIterations);

  return (
    <div className="space-y-2 p-3 border-b">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <RefreshCw
            className={cn(
              'h-3.5 w-3.5',
              status === 'RUNNING' && 'animate-spin text-primary',
              status === 'PAUSED' && 'text-amber-500',
              status === 'COMPLETED' && 'text-green-500',
              status === 'FAILED' && 'text-red-500'
            )}
          />
          <span className="text-xs font-medium">{STATUS_LABELS[status] ?? status}</span>
        </div>
        <span className="text-xs text-muted-foreground font-mono">
          {progress.currentIteration} / {maxLabel}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1 text-center">
        <div className="rounded bg-green-500/10 px-1.5 py-1">
          <div className="text-xs font-medium text-green-600">{progress.acceptedCount}</div>
          <div className="text-[10px] text-muted-foreground">Accepted</div>
        </div>
        <div className="rounded bg-orange-500/10 px-1.5 py-1">
          <div className="text-xs font-medium text-orange-600">
            {progress.rejectedRegressionCount}
          </div>
          <div className="text-[10px] text-muted-foreground">Regressed</div>
        </div>
        <div className="rounded bg-amber-500/10 px-1.5 py-1">
          <div className="text-xs font-medium text-amber-600">{progress.rejectedCritiqueCount}</div>
          <div className="text-[10px] text-muted-foreground">Critiqued</div>
        </div>
        <div className="rounded bg-red-500/10 px-1.5 py-1">
          <div className="text-xs font-medium text-red-600">{progress.crashedCount}</div>
          <div className="text-[10px] text-muted-foreground">Crashed</div>
        </div>
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex justify-between text-muted-foreground">
          <span>Baseline</span>
          <span className="font-mono">{progress.baselineMetricSummary || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Current</span>
          <span className="font-mono font-medium">{progress.currentMetricSummary || '—'}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>Target</span>
          <span className="font-mono">{config.targetDescription.slice(0, 60)}</span>
        </div>
      </div>
    </div>
  );
}

export function AutoIterationPanel({ workspaceId }: AutoIterationPanelProps) {
  const utils = trpc.useUtils();
  const { data: statusData, isLoading: statusLoading } = trpc.autoIteration.getStatus.useQuery(
    { workspaceId },
    { refetchInterval: 3000 }
  );
  const { data: logbookData } = trpc.autoIteration.getLogbook.useQuery(
    { workspaceId },
    { refetchInterval: 5000 }
  );

  const pauseMutation = trpc.autoIteration.pause.useMutation({
    onSuccess: () => void utils.autoIteration.getStatus.invalidate({ workspaceId }),
  });
  const resumeMutation = trpc.autoIteration.resume.useMutation({
    onSuccess: () => void utils.autoIteration.getStatus.invalidate({ workspaceId }),
  });
  const stopMutation = trpc.autoIteration.stop.useMutation({
    onSuccess: () => void utils.autoIteration.getStatus.invalidate({ workspaceId }),
  });

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const status = statusData?.status ?? 'IDLE';
  const progress = statusData?.progress as IterationProgress | null;
  const config = statusData?.config as IterationConfig | null;
  const iterations = (logbookData?.iterations ?? []) as LogbookEntry[];
  const isRunning = status === 'RUNNING';
  const isPaused = status === 'PAUSED';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Controls */}
      <div className="flex items-center gap-1 p-2 border-b bg-muted/30">
        <TooltipProvider>
          {isRunning && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => pauseMutation.mutate({ workspaceId })}
                  disabled={pauseMutation.isPending}
                >
                  <Pause className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pause after current iteration</TooltipContent>
            </Tooltip>
          )}
          {isPaused && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => resumeMutation.mutate({ workspaceId })}
                  disabled={resumeMutation.isPending}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Resume iteration</TooltipContent>
            </Tooltip>
          )}
          {(isRunning || isPaused) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-destructive"
                  onClick={() => stopMutation.mutate({ workspaceId })}
                  disabled={stopMutation.isPending}
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop iteration</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
        <span className="ml-auto text-[10px] text-muted-foreground">
          Auto-iteration {STATUS_LABELS[status]?.toLowerCase() ?? status}
        </span>
      </div>

      {/* Progress summary */}
      {progress && config && (
        <ProgressSummary progress={progress} config={config} status={status} />
      )}

      {/* Iteration log */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {iterations.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
            {isRunning ? 'Running baseline measurement...' : 'No iterations yet'}
          </div>
        ) : (
          <div>
            {[...iterations].reverse().map((entry) => (
              <IterationEntry key={entry.iteration} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
