import { z } from 'zod';
import {
  agentRunPageSchema,
  agentEvaluationPageSchema,
  agentWorkspaceOriginSchema,
} from '@/shared/agent-history';
import {
  agentActivationInputSchema,
  agentDeleteResultSchema,
  agentOwnerInputSchema,
  agentGetInputSchema,
  agentHistoryInputSchema,
  agentListInputSchema,
  agentListPageSchema,
  agentNavigationSummarySchema,
  agentSavedUpdateSchema,
  agentSourceResetInputSchema,
  agentSourceResetResultSchema,
  managedAgentSchema,
} from '@/shared/agent-management';
import {
  agentProposalSchema,
  createAgentFromProposalSchema,
  proposeAgentInputSchema,
} from '@/shared/agent-proposal';
import {
  agentProjectSourcesInputSchema,
  agentProjectSourcesSchema,
  agentDraftValidationInputSchema,
  agentDraftValidationSchema,
} from '@/shared/agent-validation';
import {
  agentRecoveryTargetInputSchema,
  agentRecoveryTargetSchema,
  agentRecoveryContextSchema,
  agentRecoveryInputSchema,
  agentRecoveryInspectionSchema,
  agentRecoveryResultSchema,
} from '@/shared/event-agent-recovery';
import { router, trustedLocalProcedure } from './trpc';

const referenceInput = z.strictObject({
  workspaceId: z.string().min(1),
  proposalId: z.string().min(1),
});
// Infinite queries add direction even on the first page. The domain list is
// forward-only, so validate and remove that transport metadata here.
const agentListQueryInputSchema = agentListInputSchema
  .extend({ direction: z.literal('forward').optional() })
  .transform(({ projectId, limit, cursor }) => ({ projectId, limit, cursor }));

export const agentRouter = router({
  recoveryTarget: trustedLocalProcedure
    .input(agentRecoveryTargetInputSchema)
    .output(agentRecoveryTargetSchema)
    .query(({ ctx, input }) =>
      ctx.appContext.services.agentManagementService.recoveryTarget(input)
    ),
  inspectRun: trustedLocalProcedure
    .input(agentRecoveryContextSchema)
    .output(agentRecoveryInspectionSchema)
    .query(({ ctx, input }) => ctx.appContext.services.agentManagement.inspectRun(input)),
  resolveAmbiguousRun: trustedLocalProcedure
    .input(agentRecoveryInputSchema)
    .output(agentRecoveryResultSchema)
    .mutation(({ ctx, input }) =>
      ctx.appContext.services.agentManagement.resolveAmbiguousRun(input)
    ),
  list: trustedLocalProcedure
    .input(agentListQueryInputSchema)
    .output(agentListPageSchema)
    .query(({ ctx, input }) => ctx.appContext.services.agentManagementService.list(input)),
  get: trustedLocalProcedure
    .input(agentGetInputSchema)
    .output(managedAgentSchema)
    .query(({ ctx, input }) => ctx.appContext.services.agentManagementService.get(input)),
  updateSaved: trustedLocalProcedure
    .input(agentSavedUpdateSchema)
    .output(managedAgentSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentManagement.updateSaved(input)),
  // User actions only: the MCP catalog has no activation tool.
  enable: trustedLocalProcedure
    .input(agentActivationInputSchema)
    .output(managedAgentSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentManagement.enable(input)),
  pause: trustedLocalProcedure
    .input(agentActivationInputSchema)
    .output(managedAgentSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentManagement.pause(input)),
  // Pauses, cancels queued runs and deletes; refused while a claimed run is unfinished.
  delete: trustedLocalProcedure
    .input(agentActivationInputSchema)
    .output(agentDeleteResultSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentManagement.delete(input)),
  evaluations: trustedLocalProcedure
    .input(agentHistoryInputSchema)
    .output(agentEvaluationPageSchema)
    .query(({ ctx, input }) => ctx.appContext.services.agentManagementService.evaluations(input)),
  runs: trustedLocalProcedure
    .input(agentHistoryInputSchema)
    .output(agentRunPageSchema)
    .query(({ ctx, input }) => ctx.appContext.services.agentManagement.runs(input)),
  navigationSummary: trustedLocalProcedure
    .input(agentOwnerInputSchema.pick({ projectId: true }))
    .output(agentNavigationSummarySchema)
    .query(({ ctx, input }) =>
      ctx.appContext.services.agentManagementService.navigationSummary(input)
    ),
  resetSource: trustedLocalProcedure
    .input(agentSourceResetInputSchema)
    .output(agentSourceResetResultSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentManagement.resetSource(input)),
  projectSources: trustedLocalProcedure
    .input(agentProjectSourcesInputSchema)
    .output(agentProjectSourcesSchema)
    .query(({ ctx, input }) => ctx.appContext.services.agentManagement.projectSources(input)),
  validateDraft: trustedLocalProcedure
    .input(agentDraftValidationInputSchema)
    .output(agentDraftValidationSchema)
    .mutation(({ ctx, input }) => ctx.appContext.services.agentManagement.validateDraft(input)),
  workspaceOrigin: trustedLocalProcedure
    .input(
      z.strictObject({
        projectId: z.string().min(1).max(256),
        workspaceId: z.string().min(1).max(256),
      })
    )
    .output(agentWorkspaceOriginSchema)
    .query(({ ctx, input }) => ctx.appContext.services.agentManagement.workspaceOrigin(input)),
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
