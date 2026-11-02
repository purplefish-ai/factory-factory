import { z } from 'zod';
import {
  agentCapabilitySchema,
  agentManagementIdSchema,
  savedAgentSpecificationSchema,
} from './agent-management';
import { slackConnectionSummarySchema } from './slack-connection';

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
export const agentNativeValidationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('VALIDATED'), intent: agentNativeIntentSchema }),
  z.strictObject({
    status: z.enum(['UNSUPPORTED', 'UNAVAILABLE']),
    reasonCode: z.enum(['UNSUPPORTED_REASONING_EFFORT', 'NATIVE_DISCOVERY_UNAVAILABLE']),
    explanation: z.string().max(500),
  }),
]);
export const agentDraftValidationInputSchema = z.strictObject({
  projectId: agentManagementIdSchema,
  specification: savedAgentSpecificationSchema,
});
export const agentDraftValidationSchema = z.strictObject({
  triggers: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        triggerId: agentManagementIdSchema.nullable(),
        capability: agentCapabilitySchema,
      })
    )
    .max(20),
  execution: agentNativeValidationSchema,
});
export const agentProjectSourcesInputSchema = z.strictObject({
  projectId: agentManagementIdSchema,
  connectionId: agentManagementIdSchema.optional(),
  cursor: z.string().max(1000).optional(),
});
export const agentProjectSourcesSchema = z.strictObject({
  project: z.strictObject({ id: agentManagementIdSchema, name: z.string() }),
  slack: z.strictObject({
    connections: z.array(slackConnectionSummarySchema),
    channels: z.array(z.strictObject({ id: z.string(), name: z.string() })).optional(),
    nextCursor: z.string().nullable().optional(),
  }),
  github: z.union([
    z.strictObject({
      connectionId: agentManagementIdSchema,
      repository: z.strictObject({ id: z.string(), name: z.string(), labels: z.array(z.string()) }),
    }),
    z.strictObject({ error: z.string().max(500) }),
  ]),
});
