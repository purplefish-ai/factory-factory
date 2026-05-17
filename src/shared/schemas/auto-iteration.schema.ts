import { z } from 'zod';

export const iterationPhaseSchema = z.enum([
  'baseline',
  'implementing',
  'measuring',
  'evaluating',
  'critiquing',
  'recycling',
  'idle',
]);

export const autoIterationConfigSchema = z.object({
  testCommand: z.string().min(1),
  targetDescription: z.string().min(1),
  maxIterations: z.number().int().min(0).default(25),
  testTimeoutSeconds: z.number().int().min(1).default(600),
  sessionRecycleInterval: z.number().int().min(1).default(10),
  promptTimeoutSeconds: z.number().int().min(0).optional(),
});

export const autoIterationProgressSchema = z.object({
  currentIteration: z.number().int().min(0),
  baselineMetricSummary: z.string(),
  currentMetricSummary: z.string(),
  acceptedCount: z.number().int().min(0),
  rejectedRegressionCount: z.number().int().min(0),
  rejectedCritiqueCount: z.number().int().min(0),
  crashedCount: z.number().int().min(0),
  sessionRecycleCount: z.number().int().min(0),
  startedAt: z.string(),
  lastIterationAt: z.string().nullable(),
  currentPhase: iterationPhaseSchema,
  lastTestOutput: z.string().nullable(),
});

export const agentLogbookEntrySchema = z.object({
  iteration: z.number().int().min(0),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(['accepted', 'rejected_regression', 'rejected_critique', 'crashed']),
  changeDescription: z.string(),
  commitSha: z.string(),
  commitReverted: z.boolean(),
  metricBefore: z.string(),
  metricAfter: z.string().nullable(),
  testOutput: z.string(),
  metricImproved: z.boolean().nullable(),
  crashError: z.string().nullable(),
  fixAttempts: z.number().int().min(0),
  critiqueNotes: z.string().nullable(),
  critiqueApproved: z.boolean().nullable(),
});

export const agentLogbookSchema = z.object({
  workspaceId: z.string(),
  config: autoIterationConfigSchema,
  baseline: z.object({
    testOutput: z.string(),
    metricSummary: z.string(),
    evaluatedAt: z.string(),
  }),
  iterations: z.array(agentLogbookEntrySchema),
});

export type IterationPhase = z.infer<typeof iterationPhaseSchema>;
export type AutoIterationConfig = z.infer<typeof autoIterationConfigSchema>;
export type AutoIterationProgress = z.infer<typeof autoIterationProgressSchema>;
export type AgentLogbookEntry = z.infer<typeof agentLogbookEntrySchema>;
export type AgentLogbook = z.infer<typeof agentLogbookSchema>;
