import type { AutoIterationStatus } from '@/shared/core';
import type {
  AutoIterationConfig,
  AutoIterationProgress,
} from '@/shared/schemas/auto-iteration.schema';

export type {
  AgentLogbook,
  AgentLogbookEntry,
  AutoIterationConfig,
  AutoIterationProgress,
  IterationPhase,
} from '@/shared/schemas/auto-iteration.schema';

/** Structured metric evaluation response from LLM. */
export interface MetricEvaluation {
  metricSummary: string;
  improved: boolean;
  targetReached: boolean;
}

/** Structured critique response from LLM. */
export interface CritiqueResult {
  approved: boolean;
  notes: string;
}

/** Result of running the test command. */
export interface TestCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Snapshot of auto-iteration state for API consumers. */
export interface AutoIterationSnapshot {
  status: AutoIterationStatus | null;
  config: AutoIterationConfig | null;
  progress: AutoIterationProgress | null;
}
