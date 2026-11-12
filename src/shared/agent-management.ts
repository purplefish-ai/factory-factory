import { z } from 'zod';
import { createAgentSpecificationSchema } from './agent-proposal';
import { agentActivationStateSchema, agentSourceHealthSchema } from './agent-runtime';
import {
  agentActivationGenerationSchema,
  agentDefinitionRevisionSchema,
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
} from './schemas/agent-definition.schema';

export const agentManagementIdSchema = z.string().min(1).max(256);
export const savedAgentSpecificationSchema = createAgentSpecificationSchema(256);
export type SavedAgentSpecification = z.infer<typeof savedAgentSpecificationSchema>;
export const agentOwnerInputSchema = z.strictObject({
  projectId: agentManagementIdSchema,
  agentId: agentManagementIdSchema,
});
export const agentPageFields = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2000).optional(),
};
export const agentListInputSchema = z.strictObject({
  projectId: agentManagementIdSchema,
  ...agentPageFields,
});
export const agentHistoryInputSchema = agentOwnerInputSchema.extend(agentPageFields);
export const agentGetInputSchema = agentOwnerInputSchema.extend({
  retainedCursor: z.string().max(2000).optional(),
});
export const agentSavedUpdateSchema = agentOwnerInputSchema.extend({
  expectedManagementRevision: agentDefinitionRevisionSchema,
  specification: savedAgentSpecificationSchema,
});
/** Enable and Pause are trusted-local user actions guarded by the management revision. */
export const agentActivationInputSchema = agentOwnerInputSchema.extend({
  expectedManagementRevision: agentDefinitionRevisionSchema,
});
export type AgentActivationInput = z.infer<typeof agentActivationInputSchema>;
const intentKind = z.enum(['EXPLICIT', 'INHERITED']);
export const agentNativeIntentSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum(['CLAUDE', 'CODEX']),
  model: agentManagementIdSchema,
  requestedModel: agentManagementIdSchema,
  reasoningEffort: agentManagementIdSchema.nullable(),
  providerIntent: intentKind,
  modelIntent: intentKind,
  effortIntent: intentKind,
  effortNormalization: z.enum(['NONE', 'INHERITED_TO_NATIVE_DEFAULT']),
});
export type AgentNativeIntent = z.infer<typeof agentNativeIntentSchema>;
/**
 * The execution intent Enable validated, scoped to one definition revision. It
 * gates activation and admission; inherited settings still resolve at admission.
 */
export const agentValidatedIntentSchema = z.strictObject({
  version: z.literal(1),
  definitionRevision: agentDefinitionRevisionSchema,
  validatedAt: z.iso.datetime(),
  execution: agentNativeIntentSchema,
});
export const agentPausedReasonCodeSchema = z.enum([
  'ACTIVATION_EXPIRED',
  'SOURCE_ERROR',
  'SOURCE_RECOVERY_REQUIRED',
]);
export type AgentPausedReasonCode = z.infer<typeof agentPausedReasonCodeSchema>;
/** Reset a GitHub source behind a recovery fence; the project must use the source. */
export const agentSourceResetInputSchema = z.strictObject({
  projectId: agentManagementIdSchema,
  connectionId: agentManagementIdSchema,
});
export const agentSourceResetResultSchema = z.strictObject({
  connectionId: agentManagementIdSchema,
  pausedTriggerCount: z.number().int().nonnegative(),
  cancelledRunCount: z.number().int().nonnegative(),
});
export const agentCapabilitySchema = z.strictObject({
  status: z.enum(['SUPPORTED', 'UNSUPPORTED', 'UNAVAILABLE']),
  reasonCode: z.enum([
    'SUPPORTED',
    'UNKNOWN_MEMBERSHIP',
    'REMOVED_TRIGGER',
    'INVALID_STORED_DATA',
    'UNSUPPORTED_SCHEDULE',
    'SLACK_INTAKE_UNAVAILABLE',
    'UNSUPPORTED_GITHUB_ACTION',
    'UNSUPPORTED_SEMANTIC_FILTER',
    'UNSUPPORTED_ACTOR_FILTER',
    'SOURCE_UNVERIFIED',
    'SOURCE_UNAVAILABLE',
  ]),
  explanation: z.string().max(500),
});
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export const managedTriggerSchema = z.strictObject({
  id: agentManagementIdSchema,
  isConfigured: z.boolean().nullable(),
  triggerRevision: agentDefinitionRevisionSchema,
  activationGeneration: agentActivationGenerationSchema,
  activationState: agentActivationStateSchema,
  pausedReasonCode: agentPausedReasonCodeSchema.nullable(),
  isEnabled: z.boolean(),
  configuration: agentTriggerInputSchema.nullable(),
  capability: agentCapabilitySchema,
  sourceName: z.string().max(500).nullable(),
  sourceHealth: agentSourceHealthSchema.nullable(),
});
export const agentSummarySchema = z.strictObject({
  id: agentManagementIdSchema,
  projectId: agentManagementIdSchema,
  name: z.string().max(200),
  managementRevision: agentDefinitionRevisionSchema,
  definitionRevision: agentDefinitionRevisionSchema,
  isEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const managedAgentSchema = agentSummarySchema.extend({
  configurationMembership: z.enum(['KNOWN', 'UNKNOWN']),
  instructions: z.string().max(50_000),
  executionConfig: agentExecutionConfigSchema.nullable(),
  specification: savedAgentSpecificationSchema.nullable(),
  configuredTriggers: z.array(managedTriggerSchema).max(20),
  retainedTriggers: z.array(managedTriggerSchema).max(100),
  retainedNextCursor: z.string().nullable(),
});
export const agentListPageSchema = z.strictObject({
  items: z.array(agentSummarySchema).max(100),
  nextCursor: z.string().nullable(),
});
export const agentNavigationSummarySchema = z.strictObject({
  totalCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});
export const agentSourceValidationSchema = z.strictObject({
  project: z.strictObject({
    id: agentManagementIdSchema,
    githubOwner: z.string().nullable(),
    githubRepo: z.string().nullable(),
  }),
  connections: z
    .array(
      z.strictObject({
        id: agentManagementIdSchema,
        provider: z.enum(['GITHUB', 'SLACK']),
        externalId: z.string().min(1),
      })
    )
    .max(20),
  sourceNames: z.record(z.string(), z.string().max(500)),
});
export type AgentSourceValidation = z.infer<typeof agentSourceValidationSchema>;
