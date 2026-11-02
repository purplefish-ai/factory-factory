import { ApplicationError } from '@/backend/lib/application-error';
import type {
  AgentProposalService,
  SlackConnectionService,
} from '@/backend/services/agent-definition';
import {
  agentSourceValidationSchema,
  type SavedAgentSpecification,
} from '@/shared/agent-management';
import { agentProjectSourcesSchema } from '@/shared/agent-validation';

export type AgentSourceProject = {
  id: string;
  name: string;
  isArchived: boolean;
  githubOwner: string | null;
  githubRepo: string | null;
};
export type AgentSourceServices = {
  slackConnectionService: Pick<SlackConnectionService, 'list' | 'channels' | 'channel'>;
  githubCLIService: {
    getAgentRepository(repository: string): Promise<{ id: string; name: string; labels: string[] }>;
  };
  agentProposalService: Pick<AgentProposalService, 'saveGitHubConnection'>;
};
export async function githubAgentSource(
  project: AgentSourceProject,
  services: AgentSourceServices
) {
  if (!(project.githubOwner && project.githubRepo)) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Configure the project GitHub repository first.'
    );
  }
  const repository = await services.githubCLIService.getAgentRepository(
    `${project.githubOwner}/${project.githubRepo}`
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
export async function discoverProjectAgentSources(
  project: AgentSourceProject,
  input: { connectionId?: string; cursor?: string },
  services: AgentSourceServices
) {
  const connections = (await services.slackConnectionService.list()).filter(
    (connection) => connection.isEnabled && connection.hasCredentials
  );
  if (
    input.connectionId &&
    !connections.some((connection) => connection.id === input.connectionId)
  ) {
    throw new ApplicationError('NOT_FOUND', 'Slack source not found.');
  }
  const page = input.connectionId
    ? await services.slackConnectionService.channels(input.connectionId, input.cursor)
    : null;
  let github: Awaited<ReturnType<typeof githubAgentSource>> | { error: string };
  try {
    github = await githubAgentSource(project, services);
  } catch {
    github = { error: 'GitHub source discovery failed. Check repository access and retry.' };
  }
  return agentProjectSourcesSchema.parse({
    project: { id: project.id, name: project.name },
    slack: { connections, ...page },
    github,
  });
}
/** One policy for project management and workspace proposal authoring. Names never prove access. */
export async function resolveProjectAgentSources(
  project: AgentSourceProject,
  spec: SavedAgentSpecification,
  services: AgentSourceServices
) {
  const sourceNames: Record<string, string> = {};
  const connections = new Map<
    string,
    { id: string; provider: 'GITHUB' | 'SLACK'; externalId: string }
  >();
  let github: Awaited<ReturnType<typeof githubAgentSource>> | undefined;
  const slack = spec.triggers.some((trigger) => trigger.type === 'SLACK_MESSAGE')
    ? await services.slackConnectionService.list()
    : [];
  for (const trigger of spec.triggers) {
    if (trigger.type === 'SLACK_MESSAGE') {
      const connection = await resolveSlackTrigger(trigger, slack, services, sourceNames);
      connections.set(connection.id, connection);
    } else if (trigger.type === 'GITHUB_ISSUE') {
      github ??= await githubAgentSource(project, services);
      const verified = github;
      if (
        trigger.connectionId !== github.connectionId ||
        trigger.config.repositoryIds.some((id) => id !== verified.repository.id)
      ) {
        throw new ApplicationError(
          'INVALID_INPUT',
          'Select the repository and connection discovered for this project.'
        );
      }
      if (trigger.config.labels?.some((label) => !verified.repository.labels.includes(label))) {
        throw new ApplicationError(
          'INVALID_INPUT',
          'A selected GitHub label does not exist in this repository.'
        );
      }
      connections.set(github.connectionId, {
        id: github.connectionId,
        provider: 'GITHUB',
        externalId: `gh:${github.repository.id}`,
      });
      sourceNames[`${github.connectionId}:${github.repository.id}`] = github.repository.name;
    }
  }
  return agentSourceValidationSchema.parse({
    project: { id: project.id, githubOwner: project.githubOwner, githubRepo: project.githubRepo },
    connections: [...connections.values()],
    sourceNames,
  });
}

async function resolveSlackTrigger(
  trigger: Extract<SavedAgentSpecification['triggers'][number], { type: 'SLACK_MESSAGE' }>,
  slack: Awaited<ReturnType<AgentSourceServices['slackConnectionService']['list']>>,
  services: AgentSourceServices,
  names: Record<string, string>
) {
  const connection = slack.find(
    (entry) => entry.id === trigger.connectionId && entry.isEnabled && entry.hasCredentials
  );
  if (!connection) {
    throw new ApplicationError('PRECONDITION_FAILED', 'The Slack source is unavailable.');
  }
  for (const id of trigger.config.channelIds) {
    const key = `${connection.id}:${id}`;
    if (names[key]) {
      continue;
    }
    names[key] = `#${(await services.slackConnectionService.channel(connection.id, id)).name}`;
  }
  return { id: connection.id, provider: 'SLACK' as const, externalId: connection.workspaceId };
}
