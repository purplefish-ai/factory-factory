import { z } from 'zod';

// Explicit scalar projections: relation objects and credentials never enter a backup.
export const periodicTaskRecoverySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  prompt: z.string(),
  cadence: z.enum(['EVERY_MINUTE', 'EVERY_FIVE_MINUTES', 'DAILY', 'WEEKLY', 'MONTHLY']),
  scheduledTime: z.string().nullable(),
  timezone: z.string().nullable(),
  scheduledDayOfMonth: z.number().int().nullable(),
  isEnabled: z.boolean(),
  nextRunAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const periodicTaskExecutionRecoverySchema = z.object({
  id: z.string(),
  periodicTaskId: z.string(),
  workspaceId: z.string().nullable(),
  status: z.enum(['RUNNING', 'PR_CREATED', 'COMPLETED', 'FAILED', 'SKIPPED']),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const agentDefinitionRecoverySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  instructions: z.string(),
  isEnabled: z.boolean(),
  executionConfig: z.json(),
  definitionRevision: z.number().int(),
  managementRevision: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentConnectionRecoverySchema = z.object({
  id: z.string(),
  provider: z.enum(['SLACK', 'GITHUB']),
  externalId: z.string(),
  name: z.string(),
  isEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const agentTriggerRecoverySchema = z.object({
  id: z.string(),
  agentDefinitionId: z.string(),
  type: z.enum(['SCHEDULE', 'SLACK_MESSAGE', 'GITHUB_ISSUE']),
  connectionId: z.string().nullable(),
  description: z.string(),
  config: z.json(),
  filterInstructions: z.string().nullable(),
  isEnabled: z.boolean(),
  isConfigured: z.boolean().nullable(),
  triggerRevision: z.number().int(),
  activationGeneration: z.number().int(),
  activationState: z.enum(['PAUSED', 'STARTING', 'ACTIVE']),
  activationBoundary: z.json().nullable(),
  pendingActivation: z.json().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const durableRecoverySchema = z.object({
  periodicTask: z.array(periodicTaskRecoverySchema).default([]),
  periodicTaskExecution: z.array(periodicTaskExecutionRecoverySchema).default([]),
  agentDefinition: z.array(agentDefinitionRecoverySchema).default([]),
  agentConnection: z.array(agentConnectionRecoverySchema).default([]),
  agentTrigger: z.array(agentTriggerRecoverySchema).default([]),
});
export type DurableRecovery = z.infer<typeof durableRecoverySchema>;
