import type { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentProposalService } from '@/backend/services/agent-definition';
import type {
  proposeAgentInputSchema,
  createAgentFromProposalSchema,
} from '@/shared/agent-proposal';
import {
  discoverProjectAgentSources,
  resolveProjectAgentSources,
  type AgentSourceServices,
} from './agent-sources.orchestrator';

type Services = AgentSourceServices & {
  workspaceDataService: {
    findByIdWithProject(id: string): Promise<{
      projectId: string;
      status: string;
      project: {
        name: string;
        isArchived: boolean;
        githubOwner: string | null;
        githubRepo: string | null;
      };
    } | null>;
  };
  agentProposalService: Pick<
    AgentProposalService,
    'get' | 'propose' | 'create' | 'update' | 'saveGitHubConnection'
  >;
};
async function authoringProject(workspaceId: string, services: Services) {
  const workspace = await services.workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspace) {
    throw new ApplicationError('NOT_FOUND', 'Workspace not found.');
  }
  if (
    workspace.project.isArchived ||
    workspace.status === 'ARCHIVING' ||
    workspace.status === 'ARCHIVED'
  ) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Choose an active workspace and project.');
  }
  return { ...workspace.project, id: workspace.projectId };
}
export function createAgentAuthoring(getServices: () => Services) {
  return {
    async sources(input: { workspaceId: string; connectionId?: string; cursor?: string }) {
      const services = getServices();
      const project = await authoringProject(input.workspaceId, services);
      const result = await discoverProjectAgentSources(project, input, services);
      const current = await authoringProject(input.workspaceId, services);
      if (JSON.stringify(current) !== JSON.stringify(project)) {
        throw new ApplicationError('CONFLICT', 'The project sources changed.');
      }
      return result;
    },
    async propose(input: z.infer<typeof proposeAgentInputSchema>) {
      const services = getServices();
      const evidence = await resolveProjectAgentSources(
        await authoringProject(input.workspaceId, services),
        input.specification,
        services
      );
      return services.agentProposalService.propose(input, evidence.sourceNames, evidence);
    },
    async create(input: z.infer<typeof createAgentFromProposalSchema>) {
      const services = getServices();
      const proposal = await services.agentProposalService.get(input.workspaceId, input.proposalId);
      if (proposal.agentDefinitionId) {
        return services.agentProposalService.create(input, proposal.sourceNames);
      }
      const evidence = await resolveProjectAgentSources(
        await authoringProject(input.workspaceId, services),
        input.specification,
        services
      );
      return services.agentProposalService.create(input, evidence.sourceNames, evidence);
    },
    async update(input: z.infer<typeof createAgentFromProposalSchema>) {
      const services = getServices();
      const evidence = await resolveProjectAgentSources(
        await authoringProject(input.workspaceId, services),
        input.specification,
        services
      );
      return services.agentProposalService.update(input, evidence.sourceNames, evidence);
    },
  };
}
