import { z } from 'zod';
import {
  AgentConnectionProvider,
  AgentRunStatus,
  AgentTriggerType,
  PeriodicTaskCadence,
  SessionProvider,
} from '@/shared/core/enums';
import { normalizeSessionModelForProvider } from '@/shared/session-model';

const identifier = z.string().trim().min(1);
const instructions = z.string().trim().min(1);

export const agentConnectionProviderSchema = z.enum(AgentConnectionProvider);
export const agentTriggerTypeSchema = z.enum(AgentTriggerType);
export const agentRunStatusSchema = z.enum(AgentRunStatus);
export const agentDefinitionRevisionSchema = z.number().int().positive().max(2_147_483_647);
export const agentTriggerRevisionSchema = z.number().int().positive().max(2_147_483_647);
export const agentActivationGenerationSchema = z.number().int().nonnegative().max(2_147_483_647);

export const agentExecutionConfigSchema = z
  .strictObject({
    version: z.literal(1),
    provider: z.enum(SessionProvider).optional(),
    model: identifier.optional(),
    reasoningEffort: identifier.optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.provider && (config.model || config.reasoningEffort)) {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Choose a provider when setting a model or reasoning effort',
      });
    }
    if (
      config.provider &&
      config.model &&
      !normalizeSessionModelForProvider(config.model, config.provider)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Model is not compatible with the selected provider',
      });
    }
  });

export const agentDefinitionInputSchema = z.strictObject({
  name: identifier,
  instructions,
  isEnabled: z.boolean().default(false),
  executionConfig: agentExecutionConfigSchema.default({ version: 1 }),
});

export const agentConnectionInputSchema = z.strictObject({
  provider: agentConnectionProviderSchema,
  externalId: identifier,
  name: identifier,
  isEnabled: z.boolean().default(true),
});

const scheduleConfigSchema = z
  .strictObject({
    version: z.literal(1),
    cadence: z.enum(PeriodicTaskCadence),
    scheduledTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    timezone: identifier
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid IANA timezone')
      .optional(),
    scheduledDayOfMonth: z.number().int().min(1).max(31).optional(),
  })
  .superRefine((config, ctx) => {
    if ((config.scheduledTime === undefined) !== (config.timezone === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Time and timezone must be supplied together' });
    }
    if (config.scheduledTime && ['EVERY_MINUTE', 'EVERY_FIVE_MINUTES'].includes(config.cadence)) {
      ctx.addIssue({ code: 'custom', message: 'Minute schedules cannot specify a time of day' });
    }
    if (config.scheduledDayOfMonth !== undefined && config.cadence !== 'MONTHLY') {
      ctx.addIssue({ code: 'custom', message: 'Day of month requires a monthly schedule' });
    }
  });

const contextConfigSchema = z.strictObject({
  includeThread: z.boolean().default(true),
  nearbyMessageCount: z.number().int().min(0).max(100).default(0),
});

const triggerFields = {
  // Preserve author intent independently of the configuration resolved by future NL tooling.
  description: instructions,
  filterInstructions: instructions.nullable().default(null),
  isEnabled: z.boolean().default(false),
};

export const agentTriggerInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...triggerFields,
    type: z.literal('SCHEDULE'),
    connectionId: z.null().default(null),
    config: scheduleConfigSchema,
  }),
  z.strictObject({
    ...triggerFields,
    type: z.literal('SLACK_MESSAGE'),
    connectionId: identifier,
    config: z.strictObject({
      version: z.literal(1),
      channelIds: z.array(identifier).min(1),
      senderIds: z.array(identifier).min(1).optional(),
      messageContains: instructions.optional(),
      context: contextConfigSchema.default({ includeThread: true, nearbyMessageCount: 0 }),
    }),
  }),
  z.strictObject({
    ...triggerFields,
    type: z.literal('GITHUB_ISSUE'),
    connectionId: identifier,
    config: z.strictObject({
      version: z.literal(1),
      repositoryIds: z.array(identifier).min(1),
      actions: z.array(z.enum(['opened', 'labeled', 'reopened', 'edited'])).min(1),
      labels: z.array(identifier).min(1).optional(),
      creatorIds: z.array(identifier).min(1).optional(),
    }),
  }),
]);

// Provider payloads must be normalized before becoming agent input.
export const agentRunInputSchema = z.strictObject({
  version: z.literal(1),
  eventId: identifier.optional(),
  sourceUrl: z.url().optional(),
  context: z
    .array(
      z.strictObject({
        id: identifier,
        text: z.string().max(100_000),
        url: z.url().optional(),
      })
    )
    .max(100)
    .default([]),
});

export type AgentDefinitionInput = z.infer<typeof agentDefinitionInputSchema>;
export type AgentConnectionInput = z.infer<typeof agentConnectionInputSchema>;
export type AgentTriggerInput = z.infer<typeof agentTriggerInputSchema>;
export type AgentRunInput = z.infer<typeof agentRunInputSchema>;
