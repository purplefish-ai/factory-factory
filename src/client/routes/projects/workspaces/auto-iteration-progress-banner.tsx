import { CheckCircle, ChevronRight, Loader2, Pause, XCircle } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { cn } from '@/lib/utils';

interface AutoIterationProgressBannerProps {
  workspaceId: string;
  mode: string | undefined;
}

type Stage = 'improve' | 'measure' | 'critique';
type StepState = 'pending' | 'active' | 'completed';

const STAGE_ORDER: Stage[] = ['improve', 'measure', 'critique'];

const STAGE_LABELS: Record<Stage, string> = {
  improve: 'Improve',
  measure: 'Measure',
  critique: 'Critique',
};

// Maps backend IterationPhase values to the three user-facing stages.
// 'measuring' appears twice per iteration (pre-implement scan + post-implement test)
// but is grouped under Measure since from the user's perspective it's always "running tests".
const PHASE_TO_STAGE: Partial<Record<string, Stage>> = {
  implementing: 'improve',
  measuring: 'measure',
  evaluating: 'measure',
  critiquing: 'critique',
};

const TERMINAL_STATUSES = new Set(['COMPLETED', 'STOPPED', 'MAX_ITERATIONS', 'FAILED']);

const TERMINAL_STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Completed',
  STOPPED: 'Stopped',
  MAX_ITERATIONS: 'Max iterations reached',
  FAILED: 'Failed',
};

interface BannerProgress {
  currentIteration: number;
  currentPhase: string;
  acceptedCount: number;
  rejectedRegressionCount: number;
  rejectedCritiqueCount: number;
  crashedCount: number;
  baselineMetricSummary: string;
  currentMetricSummary: string;
}

function getStepStates(currentStage: Stage | null): Record<Stage, StepState> {
  if (!currentStage) {
    return { improve: 'pending', measure: 'pending', critique: 'pending' };
  }
  const currentIdx = STAGE_ORDER.indexOf(currentStage);
  return Object.fromEntries(
    STAGE_ORDER.map((stage, i) => [
      stage,
      i < currentIdx ? 'completed' : i === currentIdx ? 'active' : 'pending',
    ])
  ) as Record<Stage, StepState>;
}

function StepDot({ state }: { state: StepState }) {
  return (
    <div
      className={cn(
        'w-2 h-2 rounded-full flex-shrink-0 transition-colors',
        state === 'completed' && 'bg-primary',
        state === 'active' && 'bg-primary animate-pulse',
        state === 'pending' && 'border border-muted-foreground/40 bg-transparent'
      )}
    />
  );
}

function StagesStepper({ currentStage }: { currentStage: Stage | null }) {
  const stepStates = getStepStates(currentStage);

  return (
    <div className="flex items-center gap-1">
      {STAGE_ORDER.map((stage, i) => (
        <div key={stage} className="flex items-center gap-1">
          {i > 0 && (
            <ChevronRight
              className={cn(
                'h-3 w-3 flex-shrink-0',
                stepStates[STAGE_ORDER[i - 1] as Stage] === 'completed'
                  ? 'text-primary'
                  : 'text-muted-foreground/40'
              )}
            />
          )}
          <div className="flex items-center gap-1.5">
            <StepDot state={stepStates[stage]} />
            <span
              className={cn(
                'text-xs font-medium',
                stepStates[stage] === 'pending' && 'text-muted-foreground'
              )}
            >
              {STAGE_LABELS[stage]}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function IterationStats({
  currentIteration,
  maxIterations,
  acceptedCount,
  totalRejected,
}: {
  currentIteration: number;
  maxIterations: number;
  acceptedCount: number;
  totalRejected: number;
}) {
  const maxLabel = maxIterations === 0 ? '' : ` / ${maxIterations}`;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
      <span>
        Iteration {currentIteration}
        {maxLabel}
      </span>
      {acceptedCount > 0 && (
        <>
          <span>·</span>
          <span className="text-green-600">{acceptedCount} accepted</span>
        </>
      )}
      {totalRejected > 0 && (
        <>
          <span>·</span>
          <span>{totalRejected} rejected</span>
        </>
      )}
    </div>
  );
}

function TerminalBanner({
  status,
  progress,
  onDismiss,
}: {
  status: string;
  progress: BannerProgress | null | undefined;
  onDismiss: () => void;
}) {
  const statusLabel = TERMINAL_STATUS_LABELS[status] ?? status;
  const currentIteration = progress?.currentIteration ?? 0;
  const acceptedCount = progress?.acceptedCount ?? 0;
  const totalRejected =
    (progress?.rejectedRegressionCount ?? 0) +
    (progress?.rejectedCritiqueCount ?? 0) +
    (progress?.crashedCount ?? 0);
  const hasImprovement =
    progress?.baselineMetricSummary &&
    progress?.currentMetricSummary &&
    progress.baselineMetricSummary !== progress.currentMetricSummary;

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-muted/30 border-b text-xs">
      <div className="flex items-center gap-1.5 shrink-0">
        {status === 'COMPLETED' ? (
          <CheckCircle className="h-3.5 w-3.5 text-green-500" />
        ) : status === 'FAILED' ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <div className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/50" />
        )}
        <span className="font-medium">{statusLabel}</span>
      </div>

      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{currentIteration} iterations</span>

      <span className="text-muted-foreground">·</span>
      <span className="text-green-600 font-medium">{acceptedCount} accepted</span>

      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{totalRejected} rejected</span>

      {hasImprovement && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono text-muted-foreground truncate max-w-[240px]">
            {progress?.baselineMetricSummary}
            <span className="mx-1">→</span>
            <span className="text-foreground font-medium">{progress?.currentMetricSummary}</span>
          </span>
        </>
      )}

      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto text-muted-foreground hover:text-foreground transition-colors leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function PausedBanner({
  progress,
  maxIterations,
}: {
  progress: BannerProgress | null | undefined;
  maxIterations: number;
}) {
  const currentIteration = progress?.currentIteration ?? 0;
  const acceptedCount = progress?.acceptedCount ?? 0;
  const totalRejected =
    (progress?.rejectedRegressionCount ?? 0) +
    (progress?.rejectedCritiqueCount ?? 0) +
    (progress?.crashedCount ?? 0);

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-amber-500/5 border-b border-amber-500/20 text-xs">
      <div className="flex items-center gap-1.5 shrink-0 text-amber-600">
        <Pause className="h-3 w-3" />
        <span className="font-medium">Paused</span>
      </div>
      {progress && (
        <IterationStats
          currentIteration={currentIteration}
          maxIterations={maxIterations}
          acceptedCount={acceptedCount}
          totalRejected={totalRejected}
        />
      )}
    </div>
  );
}

function RunningBanner({
  progress,
  maxIterations,
}: {
  progress: BannerProgress | null | undefined;
  maxIterations: number;
}) {
  const currentIteration = progress?.currentIteration ?? 0;
  const currentPhase = progress?.currentPhase ?? 'idle';
  const acceptedCount = progress?.acceptedCount ?? 0;
  const totalRejected =
    (progress?.rejectedRegressionCount ?? 0) +
    (progress?.rejectedCritiqueCount ?? 0) +
    (progress?.crashedCount ?? 0);

  // currentIteration === 0 means baseline hasn't completed yet
  if (currentIteration === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border-b text-xs">
        <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
        <span className="text-muted-foreground">Running baseline measurement...</span>
      </div>
    );
  }

  const currentStage = PHASE_TO_STAGE[currentPhase] ?? null;

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2 bg-primary/5 border-b text-xs">
      <StagesStepper currentStage={currentStage} />
      {progress && (
        <IterationStats
          currentIteration={currentIteration}
          maxIterations={maxIterations}
          acceptedCount={acceptedCount}
          totalRejected={totalRejected}
        />
      )}
    </div>
  );
}

export function AutoIterationProgressBanner({
  workspaceId,
  mode,
}: AutoIterationProgressBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [lastWorkspaceId, setLastWorkspaceId] = useState(workspaceId);
  if (workspaceId !== lastWorkspaceId) {
    setLastWorkspaceId(workspaceId);
    setDismissed(false);
  }
  const isAutoIteration = mode === 'AUTO_ITERATION';

  const { data: statusData } = trpc.autoIteration.getStatus.useQuery(
    { workspaceId },
    {
      enabled: isAutoIteration,
      refetchInterval: (query) => {
        const s = query.state.data?.status;
        if (s === 'RUNNING' || s === 'PAUSED') {
          return 3000;
        }
        if (!s || s === 'IDLE') {
          return 3000;
        } // keep polling until loop starts
        return false; // terminal state
      },
    }
  );

  if (!isAutoIteration) {
    return null;
  }

  const status = statusData?.status;
  if (!status || status === 'IDLE') {
    return null;
  }

  const isTerminal = TERMINAL_STATUSES.has(status);
  if (dismissed && isTerminal) {
    return null;
  }

  const progress = statusData?.progress as BannerProgress | null | undefined;
  const maxIterations =
    (statusData?.config as { maxIterations: number } | null | undefined)?.maxIterations ?? 0;

  if (isTerminal) {
    return (
      <TerminalBanner status={status} progress={progress} onDismiss={() => setDismissed(true)} />
    );
  }

  if (status === 'PAUSED') {
    return <PausedBanner progress={progress} maxIterations={maxIterations} />;
  }

  return <RunningBanner progress={progress} maxIterations={maxIterations} />;
}
