import type { AutoIterationConfig, AutoIterationProgress } from './auto-iteration.types';

export interface RunningLoop {
  workspaceId: string;
  sessionId: string;
  config: AutoIterationConfig;
  progress: AutoIterationProgress;
  pauseRequested: boolean;
  stopRequested: boolean;
  /** Set when the session died unexpectedly, so the loop finalizes as FAILED, not STOPPED. */
  failedByDeath: boolean;
  /** Tracks the active loop promise to prevent concurrent loops on resume. */
  loopPromise: Promise<void> | null;
  /** Number of consecutive prompt timeouts. Reset on any successful iteration. */
  consecutiveTimeoutCount: number;
}

/** Default prompt timeout: 5 minutes. A single focused code change should not take longer. */
const DEFAULT_PROMPT_TIMEOUT_SECONDS = 300;

/** Get prompt timeout in milliseconds from config, or the default. */
export function getPromptTimeoutMs(config: AutoIterationConfig): number | undefined {
  const seconds = config.promptTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS;
  return seconds > 0 ? seconds * 1000 : undefined;
}

export function createInitialRunningLoop(
  workspaceId: string,
  config: AutoIterationConfig
): RunningLoop {
  return {
    workspaceId,
    sessionId: '',
    config,
    progress: {
      currentIteration: 0,
      baselineMetricSummary: '',
      currentMetricSummary: '',
      acceptedCount: 0,
      rejectedRegressionCount: 0,
      rejectedCritiqueCount: 0,
      crashedCount: 0,
      sessionRecycleCount: 0,
      startedAt: new Date().toISOString(),
      lastIterationAt: null,
      currentPhase: 'baseline',
      lastTestOutput: null,
    },
    pauseRequested: false,
    stopRequested: false,
    failedByDeath: false,
    loopPromise: null,
    consecutiveTimeoutCount: 0,
  };
}

export function createFailedResumeRunningLoop(
  workspaceId: string,
  config: AutoIterationConfig,
  progress: AutoIterationProgress
): RunningLoop {
  return {
    workspaceId,
    sessionId: '',
    config,
    progress: { ...progress, currentPhase: 'idle' },
    pauseRequested: false,
    stopRequested: false,
    failedByDeath: false,
    loopPromise: null,
    consecutiveTimeoutCount: 0,
  };
}
