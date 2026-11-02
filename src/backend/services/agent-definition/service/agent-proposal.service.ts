import { ApplicationError } from '@/backend/lib/application-error';
import { agentProposalAccessor } from '@/backend/services/agent-definition/resources/agent-proposal.accessor';
import { agentSourceValidationSchema, type AgentSourceValidation } from '@/shared/agent-management';
import {
  agentProposalSchema,
  createAgentFromProposalSchema,
  proposeAgentInputSchema,
} from '@/shared/agent-proposal';

function publicProposal(row: unknown) {
  // Prisma rows include timestamps; validate and select the public shape.
  return agentProposalSchema.strip().parse(row);
}

export class AgentProposalService {
  async get(workspaceId: string, proposalId: string) {
    const row = await agentProposalAccessor.get(workspaceId, proposalId);
    if (!row) {
      throw new ApplicationError('NOT_FOUND', 'Agent proposal not found in this workspace.');
    }
    return publicProposal(row);
  }
  async propose(
    input: unknown,
    sourceNames: Record<string, string> = {},
    evidence?: AgentSourceValidation
  ) {
    const parsed = proposeAgentInputSchema.parse(input);
    parsed.specification.triggers = parsed.specification.triggers.map((trigger) => ({
      ...trigger,
      id: trigger.id ?? crypto.randomUUID(),
    }));
    return publicProposal(
      await agentProposalAccessor.propose({
        ...parsed,
        sourceNames,
        evidence: evidence ? agentSourceValidationSchema.parse(evidence) : undefined,
      })
    );
  }
  async create(
    input: unknown,
    sourceNames: Record<string, string> = {},
    evidence?: AgentSourceValidation
  ) {
    const parsed = createAgentFromProposalSchema.parse(input);
    return publicProposal(
      await agentProposalAccessor.create({
        ...parsed,
        sourceNames,
        evidence: evidence ? agentSourceValidationSchema.parse(evidence) : undefined,
      })
    );
  }
  async update(
    input: unknown,
    sourceNames: Record<string, string> = {},
    evidence?: AgentSourceValidation
  ) {
    const parsed = createAgentFromProposalSchema.parse(input);
    return publicProposal(
      await agentProposalAccessor.update({
        ...parsed,
        sourceNames,
        evidence: evidence ? agentSourceValidationSchema.parse(evidence) : undefined,
      })
    );
  }
  saveGitHubConnection(repositoryId: string, name: string) {
    return agentProposalAccessor.saveGitHubConnection(repositoryId, name);
  }
}
