import type { AutoIterationStatus } from '@/shared/core';

/** Configuration for an auto-iteration workspace. Stored as JSON in Workspace.autoIterationConfig. */
export interface AutoIterationConfig {
  testCommand: string;
  targetDescription: string;
  maxIterations: number; // 0 = unlimited
  testTimeoutSeconds: number; // default: 600
  sessionRecycleInterval: number; // default: 10
  promptTimeoutSeconds?: number; // default: 1200 (20 minutes); undefined = no timeout
}

/** Phase of the current iteration for real-time UI display. */
export type IterationPhase =
  | 'baseline'
  | 'implementing'
  | 'measuring'
  | 'evaluating'
  | 'critiquing'
  | 'recycling'
  | 'idle';

/** Progress snapshot for an auto-iteration workspace. Stored as JSON in Workspace.autoIterationProgress. */
export interface AutoIterationProgress {
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
  /** Current phase of the active iteration — drives the phase indicator in the UI. */
  currentPhase: IterationPhase;
  /** Most recent test command output (truncated). Updated live while the test runs. */
  lastTestOutput: string | null;
  /** Result of the most recent LLM metric evaluation. Set after eval, cleared at next iteration start. */
  lastEvalDecision: { improved: boolean; metricSummary: string } | null;
}

/** A single entry in the agent logbook. */
export interface AgentLogbookEntry {
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

/** The full agent logbook structure stored at .factory-factory/auto-iteration-logbook.json */
export interface AgentLogbook {
  workspaceId: string;
  config: AutoIterationConfig;
  baseline: {
    testOutput: string;
    metricSummary: string;
    evaluatedAt: string;
  };
  iterations: AgentLogbookEntry[];
}

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
