import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentSourceValidation, SavedAgentSpecification } from '@/shared/agent-management';
import { agentSpecificationSchema } from '@/shared/agent-proposal';
import type { AgentConnection, Prisma } from '@prisma-gen/client';

export async function validateManagementSources(
  tx: Prisma.TransactionClient,
  projectId: string,
  specification: SavedAgentSpecification,
  evidence?: AgentSourceValidation
) {
  const project = await tx.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new ApplicationError('NOT_FOUND', 'Project not found.');
  }
  if (project.isArchived) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Choose an active project.');
  }
  if (
    evidence &&
    (evidence.project.id !== projectId ||
      evidence.project.githubOwner !== project.githubOwner ||
      evidence.project.githubRepo !== project.githubRepo)
  ) {
    throw new ApplicationError('CONFLICT', 'The project sources changed. Discover sources again.');
  }
  for (const trigger of specification.triggers) {
    if (trigger.type === 'SCHEDULE') {
      continue;
    }
    const connection = await tx.agentConnection.findUnique({ where: { id: trigger.connectionId } });
    validateConnection(connection, trigger, evidence);
  }
}

export async function resolveSavedTriggerIds(
  tx: Prisma.TransactionClient,
  agentId: string,
  specification: SavedAgentSpecification,
  proposalId?: string
) {
  const ids = specification.triggers.flatMap((trigger) => (trigger.id ? [trigger.id] : []));
  const owned = await tx.agentTrigger.findMany({
    where: { agentDefinitionId: agentId, id: { in: ids } },
    select: { id: true },
  });
  if (owned.length !== ids.length) {
    throw new ApplicationError('NOT_FOUND', 'An event does not belong to this agent.');
  }
  return specification.triggers.map((trigger) => ({
    ...trigger,
    id: trigger.id ?? (proposalId ? `${proposalId}:${crypto.randomUUID()}` : crypto.randomUUID()),
  }));
}

export function proposalSpecification(specification: SavedAgentSpecification, proposalId: string) {
  const prefix = `${proposalId}:`;
  const triggers = specification.triggers.map((trigger) => {
    if (!trigger.id?.startsWith(prefix)) {
      throw new ApplicationError('CONFLICT', 'The proposal event identity is unavailable.');
    }
    return { ...trigger, id: trigger.id.slice(prefix.length) };
  });
  return agentSpecificationSchema.parse({ ...specification, triggers });
}

function validateConnection(
  connection: AgentConnection | null,
  trigger: Exclude<SavedAgentSpecification['triggers'][number], { type: 'SCHEDULE' }>,
  evidence?: AgentSourceValidation
) {
  const expected = evidence?.connections.find((item) => item.id === trigger.connectionId);
  const provider = trigger.type === 'GITHUB_ISSUE' ? 'GITHUB' : 'SLACK';
  if (
    !connection?.isEnabled ||
    connection.provider !== provider ||
    (provider === 'SLACK' && !connection.credentialsEncrypted) ||
    (evidence &&
      (!expected ||
        expected.provider !== connection.provider ||
        expected.externalId !== connection.externalId)) ||
    (trigger.type === 'GITHUB_ISSUE' &&
      trigger.config.repositoryIds.some((id) => connection.externalId !== `gh:${id}`))
  ) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'The selected source is unavailable or changed.'
    );
  }
}
