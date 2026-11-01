import { z } from 'zod';
import { agentExecutionConfigSchema } from './schemas/agent-definition.schema';

export const eventLaunchIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), 'Must be nonblank and unpadded');
const identifier = eventLaunchIdentifierSchema;
/** Immutable effective intent, distinct from mutable provider/session configuration. */
export const eventAgentExecutionSchema = z
  .discriminatedUnion('provider', [
    z.strictObject({
      version: z.literal(1),
      provider: z.literal('CLAUDE'),
      model: identifier,
      reasoningEffort: identifier.nullable(),
      codexAccountId: z.null(),
      startupModePreset: z.literal('non_interactive'),
      accessMode: identifier,
      planModeEnabled: z.literal(false),
    }),
    z.strictObject({
      version: z.literal(1),
      provider: z.literal('CODEX'),
      model: identifier,
      reasoningEffort: identifier.nullable(),
      codexAccountId: identifier,
      startupModePreset: z.literal('non_interactive'),
      accessMode: identifier,
      planModeEnabled: z.literal(false),
    }),
  ])
  .refine(
    (execution) =>
      agentExecutionConfigSchema.safeParse({
        version: 1,
        provider: execution.provider,
        model: execution.model,
      }).success,
    { message: 'Model does not match the execution provider', path: ['model'] }
  );
export type EventAgentExecution = z.infer<typeof eventAgentExecutionSchema>;

export const eventSessionCreationSchema = z.strictObject({
  id: identifier,
  workspaceId: identifier,
  runId: identifier,
  execution: eventAgentExecutionSchema,
});
export type EventSessionCreation = z.infer<typeof eventSessionCreationSchema>;

export const eventWorkspaceIdentitySchema = z.strictObject({
  version: z.literal(1),
  runId: identifier,
  reservedSessionId: identifier,
  initialMessageId: identifier,
});

export type EventWorkspaceIdentity = z.infer<typeof eventWorkspaceIdentitySchema>;
