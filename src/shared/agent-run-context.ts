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
