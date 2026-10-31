import { ApplicationError } from '@/backend/lib/application-error';
import { agentProposalAccessor } from '@/backend/services/agent-definition/resources/agent-proposal.accessor';
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
  async propose(input: unknown, sourceNames: Record<string, string> = {}) {
    const parsed = proposeAgentInputSchema.parse(input);
    return publicProposal(await agentProposalAccessor.propose({ ...parsed, sourceNames }));
  }
  async create(input: unknown, sourceNames: Record<string, string> = {}) {
    const parsed = createAgentFromProposalSchema.parse(input);
    return publicProposal(await agentProposalAccessor.create({ ...parsed, sourceNames }));
  }
  async update(input: unknown, sourceNames: Record<string, string> = {}) {
    const parsed = createAgentFromProposalSchema.parse(input);
    return publicProposal(await agentProposalAccessor.update({ ...parsed, sourceNames }));
  }
  saveGitHubConnection(repositoryId: string, name: string) {
    return agentProposalAccessor.saveGitHubConnection(repositoryId, name);
  }
}
