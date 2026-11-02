import { z } from 'zod';
import {
  agentDefinitionInputSchema,
  agentRunInputSchema,
  agentTriggerInputSchema,
} from './schemas/agent-definition.schema';

/** Stored context has a lifecycle distinct from executable launch input and compact outcomes. */
export const expiredAgentRunContextSchema = z.strictObject({
  version: z.literal(1),
  state: z.literal('EXPIRED'),
  expiredAt: z.iso.datetime(),
});
// These containers project context fields from a full AgentRun. Other row fields
// are intentionally omitted; the context payloads themselves remain strict.
export const retainedAgentRunContextSchema = z.object({
  contextExpiredAt: z.null(),
  definitionSnapshot: agentDefinitionInputSchema,
  triggerSnapshot: agentTriggerInputSchema.nullable(),
  input: agentRunInputSchema,
});
export const storedAgentRunContextSchema = z.union([
  retainedAgentRunContextSchema,
  z
    .object({
      contextExpiredAt: z.iso.datetime(),
      definitionSnapshot: expiredAgentRunContextSchema,
      triggerSnapshot: expiredAgentRunContextSchema,
      input: expiredAgentRunContextSchema,
    })
    .refine(
      (row) =>
        [row.definitionSnapshot, row.triggerSnapshot, row.input].every(
          (context) => context.expiredAt === row.contextExpiredAt
        ),
      'Expired context must be replaced atomically'
    ),
]);

/** Prospective days preview eligibility without enabling the deletion policy. */
export const inspectAgentRunContextsInputSchema = z.strictObject({
  after: z.string().min(1).max(256).nullable().optional(),
  retentionDays: z.number().int().positive().max(365_000).optional(),
});
export type InspectAgentRunContextsInput = z.infer<typeof inspectAgentRunContextsInputSchema>;
