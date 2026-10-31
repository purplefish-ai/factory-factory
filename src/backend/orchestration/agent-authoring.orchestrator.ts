import type { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import type {
  AgentProposalService,
  SlackConnectionService,
} from '@/backend/services/agent-definition';
import type {
  proposeAgentInputSchema,
  createAgentFromProposalSchema,
  AgentSpecification,
} from '@/shared/agent-proposal';

type Services = {
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
  slackConnectionService: Pick<SlackConnectionService, 'list' | 'channels' | 'channel'>;
  githubCLIService: {
    getAgentRepository(repository: string): Promise<{ id: string; name: string; labels: string[] }>;
  };
  agentProposalService: Pick<
    AgentProposalService,
    'get' | 'propose' | 'create' | 'update' | 'saveGitHubConnection'
  >;
};

async function authoringWorkspace(workspaceId: string, services: Services) {
  const workspace = await services.workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspace) {
    throw new ApplicationError('NOT_FOUND', 'Workspace not found.');
  }
  if (workspace.project.isArchived || workspace.status === 'ARCHIVED') {
    throw new ApplicationError('PRECONDITION_FAILED', 'Choose an active workspace and project.');
  }
  return workspace;
}

async function githubSource(
  workspace: Awaited<ReturnType<typeof authoringWorkspace>>,
  services: Services
) {
  const { githubOwner, githubRepo } = workspace.project;
  if (!(githubOwner && githubRepo)) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Configure the project GitHub repository first.'
    );
  }
  const repository = await services.githubCLIService.getAgentRepository(
    `${githubOwner}/${githubRepo}`
  );
  const connection = await services.agentProposalService.saveGitHubConnection(
    repository.id,
    repository.name
  );
  if (!connection.isEnabled) {
    throw new ApplicationError('PRECONDITION_FAILED', 'This GitHub connection is disabled.');
  }
  return { connectionId: connection.id, repository };
}

export async function discoverAgentSources(
  input: { workspaceId: string; connectionId?: string; cursor?: string },
  services: Services
) {
  const workspace = await authoringWorkspace(input.workspaceId, services);
  const connections = (await services.slackConnectionService.list()).filter(
    (connection) => connection.isEnabled && connection.hasCredentials
  );
  const page = input.connectionId
    ? await services.slackConnectionService.channels(input.connectionId, input.cursor)
    : null;
  let github: Awaited<ReturnType<typeof githubSource>> | { error: string };
  try {
    github = await githubSource(workspace, services);
  } catch (error) {
    github = {
      error:
        error instanceof ApplicationError
          ? error.message
          : 'GitHub source discovery failed. Check repository access and retry.',
    };
  }
  return {
    project: { id: workspace.projectId, name: workspace.project.name },
    slack: { connections, ...page },
    github,
    executionAvailable: false,
  };
}

/** Resolve names server-side; model-provided labels are never proof of access. */
function validateGithubTrigger(
  trigger: Extract<AgentSpecification['triggers'][number], { type: 'GITHUB_ISSUE' }>,
  github: Awaited<ReturnType<typeof githubSource>>
) {
  if (
    trigger.connectionId !== github.connectionId ||
    trigger.config.repositoryIds.some((id) => id !== github.repository.id)
  ) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'Select the GitHub repository and connection returned by source discovery for this project.'
    );
  }
  if (trigger.config.labels?.some((label) => !github.repository.labels.includes(label))) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'A selected GitHub label does not exist in this repository.'
    );
  }
}

export async function resolveAgentSources(
  workspaceId: string,
  spec: AgentSpecification,
  services: Services
) {
  const workspace = await authoringWorkspace(workspaceId, services);
  const names: Record<string, string> = {};
  const checked = new Set<string>();
  let github: Awaited<ReturnType<typeof githubSource>> | undefined;
  for (const trigger of spec.triggers) {
    if (trigger.type === 'SLACK_MESSAGE') {
      for (const id of trigger.config.channelIds) {
        const key = `${trigger.connectionId}:${id}`;
        if (checked.has(key)) {
          continue;
        }
        const channel = await services.slackConnectionService.channel(trigger.connectionId, id);
        names[key] = `#${channel.name}`;
        checked.add(key);
      }
    } else if (trigger.type === 'GITHUB_ISSUE') {
      github ??= await githubSource(workspace, services);
      validateGithubTrigger(trigger, github);
      names[`${trigger.connectionId}:${github.repository.id}`] = github.repository.name;
    }
  }
  return names;
}

export function createAgentAuthoring(getServices: () => Services) {
  return {
    sources(input: { workspaceId: string; connectionId?: string; cursor?: string }) {
      return discoverAgentSources(input, getServices());
    },
    async propose(input: z.infer<typeof proposeAgentInputSchema>) {
      const services = getServices();
      const names = await resolveAgentSources(input.workspaceId, input.specification, services);
      return services.agentProposalService.propose(input, names);
    },
    async create(input: z.infer<typeof createAgentFromProposalSchema>) {
      const services = getServices();
      const proposal = await services.agentProposalService.get(input.workspaceId, input.proposalId);
      const names = proposal.agentDefinitionId
        ? proposal.sourceNames
        : await resolveAgentSources(input.workspaceId, input.specification, services);
      return services.agentProposalService.create(input, names);
    },
    async update(input: z.infer<typeof createAgentFromProposalSchema>) {
      const services = getServices();
      const names = await resolveAgentSources(input.workspaceId, input.specification, services);
      return services.agentProposalService.update(input, names);
    },
  };
}
