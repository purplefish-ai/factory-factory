import { z } from 'zod';
import {
  agentProposalSchema,
  createAgentFromProposalSchema,
  proposeAgentInputSchema,
} from '@/shared/agent-proposal';
import { router, trustedLocalProcedure } from './trpc';

const referenceInput = z.strictObject({
  workspaceId: z.string().min(1),
  proposalId: z.string().min(1),
});
export const agentRouter = router({
  update: trustedLocalProcedure
    .input(createAgentFromProposalSchema)
    .output(agentProposalSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentAuthoring.update(input)),
  sources: trustedLocalProcedure
    .input(
      z.strictObject({
        workspaceId: z.string().min(1),
        connectionId: z.string().min(1).optional(),
        cursor: z.string().max(1000).optional(),
      })
    )
    .query(({ ctx, input }) => ctx.appContext.services.agentAuthoring.sources(input)),
  propose: trustedLocalProcedure
    .input(proposeAgentInputSchema)
    .output(agentProposalSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentAuthoring.propose(input)),
  getProposal: trustedLocalProcedure
    .input(referenceInput)
    .output(agentProposalSchema)
    .query(({ ctx, input }) =>
      ctx.appContext.services.agentProposalService.get(input.workspaceId, input.proposalId)
    ),
  create: trustedLocalProcedure
    .input(createAgentFromProposalSchema)
    .output(agentProposalSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentAuthoring.create(input)),
});
