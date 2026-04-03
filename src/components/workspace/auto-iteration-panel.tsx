import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  List,
  Loader2,
  OctagonX,
  Pause,
  Play,
  RefreshCw,
  Save,
  Square,
  Terminal,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
  currentPhase?: string;
  lastTestOutput?: string | null;
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

interface LogbookData {
  baseline?: { testOutput: string; metricSummary: string; evaluatedAt: string };
  iterations: LogbookEntry[];
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

const PHASE_LABELS: Record<string, string> = {
  baseline: 'Running baseline test...',
  implementing: 'Agent implementing changes...',
  measuring: 'Running test command...',
  evaluating: 'Evaluating metrics...',
  critiquing: 'Critiquing changes...',
  recycling: 'Recycling session...',
  idle: 'Between iterations',
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

function TestOutputBlock({ output, maxLines = 30 }: { output: string; maxLines?: number }) {
  const [showAll, setShowAll] = useState(false);
  const lines = output.split('\n');
  const truncated = !showAll && lines.length > maxLines;
  const displayText = truncated ? lines.slice(-maxLines).join('\n') : output;

  return (
    <div className="relative">
      {truncated && (
        <button
          type="button"
          className="text-[10px] text-primary hover:underline mb-0.5"
          onClick={() => setShowAll(true)}
        >
          Show all {lines.length} lines
        </button>
      )}
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/50 rounded p-1.5 max-h-48 overflow-y-auto text-muted-foreground">
        {displayText}
      </pre>
    </div>
  );
}

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
          {entry.testOutput && (
            <div className="mt-1">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
                <Terminal className="h-2.5 w-2.5" />
                Test output
              </div>
              <TestOutputBlock output={entry.testOutput} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseIndicator({ phase }: { phase: string }) {
  const label = PHASE_LABELS[phase] ?? phase;
  const isActive = phase !== 'idle';

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 text-xs border-b',
        isActive ? 'bg-primary/5 text-primary' : 'bg-muted/20 text-muted-foreground'
      )}
    >
      {isActive ? (
        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
      ) : (
        <RefreshCw className="h-3 w-3 shrink-0" />
      )}
      <span>{label}</span>
    </div>
  );
}

function LiveTestOutput({ output }: { output: string }) {
  // Auto-scroll to bottom on each render (component only re-renders when output prop changes)
  const scrollToBottom = (el: HTMLPreElement | null) => {
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  };

  return (
    <div className="border-b">
      <div className="flex items-center gap-1 px-3 py-1 text-[10px] text-muted-foreground bg-muted/20">
        <Terminal className="h-2.5 w-2.5" />
        Latest test output
      </div>
      <pre
        ref={scrollToBottom}
        className="text-[11px] font-mono whitespace-pre-wrap break-all px-3 py-1.5 max-h-40 overflow-y-auto text-muted-foreground"
      >
        {output}
      </pre>
    </div>
  );
}

function BaselineSection({ baseline }: { baseline: LogbookData['baseline'] }) {
  const [expanded, setExpanded] = useState(false);

  if (!baseline) {
    return null;
  }

  return (
    <div className="border-b border-border/50">
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
        <RefreshCw className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-medium">Baseline</span>
            <span className="text-xs text-blue-500">{baseline.metricSummary}</span>
          </div>
        </div>
      </button>
      {expanded && baseline.testOutput && (
        <div className="px-8 pb-2">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
            <Terminal className="h-2.5 w-2.5" />
            Baseline test output
          </div>
          <TestOutputBlock output={baseline.testOutput} />
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

const TEST_OUTPUT_PHASES = new Set(['evaluating', 'measuring', 'implementing', 'baseline']);

const TERMINAL_STATUSES = new Set(['FAILED', 'STOPPED', 'MAX_ITERATIONS', 'COMPLETED']);

function AutoIterationControls({ workspaceId, status }: { workspaceId: string; status: string }) {
  const isRunning = status === 'RUNNING';
  const isPaused = status === 'PAUSED';
  const isTerminal = TERMINAL_STATUSES.has(status);

  const utils = trpc.useUtils();
  const invalidate = () => void utils.autoIteration.getStatus.invalidate({ workspaceId });
  const onError = (error: { message: string }) =>
    toast.error(`Auto-iteration action failed: ${error.message}`);
  const pauseMutation = trpc.autoIteration.pause.useMutation({ onSuccess: invalidate, onError });
  const resumeMutation = trpc.autoIteration.resume.useMutation({ onSuccess: invalidate, onError });
  const stopMutation = trpc.autoIteration.stop.useMutation({ onSuccess: invalidate, onError });
  const startMutation = trpc.autoIteration.start.useMutation({ onSuccess: invalidate, onError });

  return (
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
      {isTerminal && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => startMutation.mutate({ workspaceId })}
              disabled={startMutation.isPending}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', startMutation.isPending && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Restart auto-iteration</TooltipContent>
        </Tooltip>
      )}
    </TooltipProvider>
  );
}

function InsightsEditor({ workspaceId }: { workspaceId: string }) {
  const { data: insightsData, isLoading } = trpc.autoIteration.getInsights.useQuery(
    { workspaceId },
    { refetchOnWindowFocus: false }
  );
  const [content, setContent] = useState<string>('');
  const [dirty, setDirty] = useState(false);

  // Sync fetched content into local state (only on initial load or refetch when not dirty)
  useEffect(() => {
    if (insightsData !== undefined && !dirty) {
      setContent(insightsData ?? '');
    }
  }, [insightsData, dirty]);

  const utils = trpc.useUtils();
  const saveMutation = trpc.autoIteration.saveInsights.useMutation({
    onSuccess: () => {
      setDirty(false);
      void utils.autoIteration.getInsights.invalidate({ workspaceId });
      toast.success('Insights saved');
    },
    onError: (err) => toast.error(`Failed to save insights: ${err.message}`),
  });

  const handleChange = (value: string) => {
    setContent(value);
    setDirty(true);
  };

  const handleSave = () => {
    saveMutation.mutate({ workspaceId, content });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/20">
        <span className="text-[10px] text-muted-foreground">
          Markdown — tag entries [open], [resolved], or [obsolete]
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[10px]"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending}
        >
          <Save className="h-3 w-3" />
          {dirty ? 'Save' : 'Saved'}
        </Button>
      </div>
      <textarea
        className="flex-1 min-h-0 w-full resize-none bg-transparent p-3 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none"
        value={content}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="# Auto-Iteration Insights&#10;&#10;Add ideas, deferred approaches, or observations here.&#10;Tag with [open], [resolved], or [obsolete]."
        spellCheck={false}
      />
    </div>
  );
}

type PanelTab = 'log' | 'insights';

function TabBar({ active, onChange }: { active: PanelTab; onChange: (t: PanelTab) => void }) {
  return (
    <div className="flex border-b shrink-0">
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
          active === 'log'
            ? 'border-b-2 border-primary text-primary'
            : 'text-muted-foreground hover:text-foreground'
        )}
        onClick={() => onChange('log')}
      >
        <List className="h-3 w-3" />
        Log
      </button>
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
          active === 'insights'
            ? 'border-b-2 border-primary text-primary'
            : 'text-muted-foreground hover:text-foreground'
        )}
        onClick={() => onChange('insights')}
      >
        <Lightbulb className="h-3 w-3" />
        Insights
      </button>
    </div>
  );
}

function IterationLog({ logbook, isRunning }: { logbook: LogbookData | null; isRunning: boolean }) {
  const iterations = (logbook?.iterations ?? []) as LogbookEntry[];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {iterations.length === 0 && !logbook?.baseline ? (
        <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
          {isRunning ? 'Running baseline measurement...' : 'No iterations yet'}
        </div>
      ) : (
        <div>
          {[...iterations].reverse().map((entry) => (
            <IterationEntry key={entry.iteration} entry={entry} />
          ))}
          {logbook?.baseline && <BaselineSection baseline={logbook.baseline} />}
        </div>
      )}
    </div>
  );
}

export function AutoIterationPanel({ workspaceId }: AutoIterationPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('log');

  const { data: statusData, isLoading: statusLoading } = trpc.autoIteration.getStatus.useQuery(
    { workspaceId },
    { refetchInterval: 3000 }
  );
  const { data: logbookData } = trpc.autoIteration.getLogbook.useQuery(
    { workspaceId },
    { refetchInterval: 5000 }
  );

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
  const logbook = logbookData as LogbookData | null;
  const isRunning = status === 'RUNNING';
  const currentPhase = progress?.currentPhase ?? 'idle';
  const lastTestOutput = progress?.lastTestOutput;
  const showLiveOutput = isRunning && lastTestOutput && TEST_OUTPUT_PHASES.has(currentPhase);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 p-2 border-b bg-muted/30">
        <AutoIterationControls workspaceId={workspaceId} status={status} />
        <span className="ml-auto text-[10px] text-muted-foreground">
          Auto-iteration {STATUS_LABELS[status]?.toLowerCase() ?? status}
        </span>
      </div>

      {progress && config && (
        <ProgressSummary progress={progress} config={config} status={status} />
      )}

      {isRunning && <PhaseIndicator phase={currentPhase} />}

      {showLiveOutput && <LiveTestOutput output={lastTestOutput} />}

      <TabBar active={activeTab} onChange={setActiveTab} />

      {activeTab === 'log' ? (
        <IterationLog logbook={logbook} isRunning={isRunning} />
      ) : (
        <InsightsEditor workspaceId={workspaceId} />
      )}
    </div>
  );
}
