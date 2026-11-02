import type { trpc } from '@/client/lib/trpc';
import { agentProposalSchema } from '@/shared/agent-proposal';

/** Refresh only the project that owns the completed mutation, including after navigation. */
export function invalidateAgentProjectQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string
) {
  return Promise.all([
    utils.periodicTask.list.invalidate({ projectId }),
    utils.periodicTask.navigationSummary.invalidate({ projectId }),
    utils.agent.list.invalidate({ projectId }),
    utils.agent.navigationSummary.invalidate({ projectId }),
  ]);
}
/** Partial input deliberately covers all retainedCursor variants for this saved owner. */
export function invalidateSavedAgentQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string,
  agentId: string
) {
  return Promise.all([
    utils.agent.list.invalidate({ projectId }),
    utils.agent.navigationSummary.invalidate({ projectId }),
    utils.agent.get.invalidate({ projectId, agentId }),
    utils.agent.getProposal.invalidate(undefined, {
      predicate: (query) => {
        const proposal = agentProposalSchema.safeParse(query.state.data);
        return proposal.success && proposal.data.agentDefinitionId === agentId;
      },
    }),
  ]);
}
