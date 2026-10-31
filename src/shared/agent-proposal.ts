import { z } from 'zod';
import {
  agentDefinitionInputSchema,
  agentTriggerInputSchema,
} from './schemas/agent-definition.schema';

const paused = {
  isEnabled: z.literal(false).default(false),
  id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Stable event ID returned by proposals. Preserve it when editing or reordering existing events; omit it only for new events.'
    ),
};
const authoringTriggerSchema = z.discriminatedUnion('type', [
  agentTriggerInputSchema.options[0].extend(paused),
  agentTriggerInputSchema.options[1].extend(paused),
  agentTriggerInputSchema.options[2].extend(paused),
]);

export const agentSpecificationSchema = agentDefinitionInputSchema
  .omit({ isEnabled: true })
  .extend({
    name: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(50_000),
    triggers: z.array(authoringTriggerSchema).min(1).max(20),
  })
  .superRefine((specification, ctx) => {
    const ids = specification.triggers.flatMap((trigger) => (trigger.id ? [trigger.id] : []));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'Each event needs a unique stable ID.' });
    }
    if (
      specification.triggers.some(
        (trigger) =>
          (trigger.type === 'SLACK_MESSAGE' && trigger.config.senderIds) ||
          (trigger.type === 'GITHUB_ISSUE' && trigger.config.creatorIds)
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Actor-specific restrictions require actor discovery, which is not available yet. Use channels, repositories, labels, and semantic filters.',
      });
    }
  });

export const proposeAgentInputSchema = z
  .strictObject({
    workspaceId: z.string().min(1),
    proposalId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
    specification: agentSpecificationSchema,
  })
  .refine((input) => Boolean(input.proposalId) === (input.revision !== undefined), {
    message: 'Provide both proposalId and revision when updating a proposal.',
  });

export const agentProposalReferenceSchema = z.strictObject({
  type: z.literal('agent_proposal'),
  workspaceId: z.string().min(1),
  proposalId: z.string().min(1),
  revision: z.number().int().positive().optional(),
});

export const agentProposalSchema = z.strictObject({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  revision: z.number().int().positive(),
  specification: agentSpecificationSchema,
  sourceNames: z.record(z.string(), z.string()),
  agentDefinitionId: z.string().nullable(),
});

export const createAgentFromProposalSchema = z.strictObject({
  workspaceId: z.string().min(1),
  proposalId: z.string().min(1),
  revision: z.number().int().positive(),
  specification: agentSpecificationSchema,
});

export type AgentSpecification = z.infer<typeof agentSpecificationSchema>;
export type AgentProposal = z.infer<typeof agentProposalSchema>;
export type AgentProposalReference = z.infer<typeof agentProposalReferenceSchema>;
