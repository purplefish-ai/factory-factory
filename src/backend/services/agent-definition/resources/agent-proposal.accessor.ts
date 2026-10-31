import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentSpecification } from '@/shared/agent-proposal';
import type { Prisma } from '@prisma-gen/client';

type Transaction = Prisma.TransactionClient;
export type ProposalWrite = {
  workspaceId: string;
  proposalId?: string;
  revision?: number;
  specification: AgentSpecification;
  sourceNames: Record<string, string>;
};
const stale = () =>
  new ApplicationError('CONFLICT', 'This proposal changed. Reload it before continuing.');

async function validate(tx: Transaction, workspaceId: string, spec: AgentSpecification) {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    include: { project: true },
  });
  if (!workspace) {
    throw new ApplicationError('NOT_FOUND', 'Workspace not found.');
  }
  if (workspace.project.isArchived || workspace.status === 'ARCHIVED') {
    throw new ApplicationError('PRECONDITION_FAILED', 'Choose an active workspace and project.');
  }
  for (const trigger of spec.triggers) {
    if (trigger.type === 'SCHEDULE') {
      continue;
    }
    const connection = await tx.agentConnection.findUnique({
      where: { id: trigger.connectionId },
      select: { provider: true, isEnabled: true, credentialsEncrypted: true },
    });
    const provider = trigger.type === 'SLACK_MESSAGE' ? 'SLACK' : 'GITHUB';
    if (
      !connection?.isEnabled ||
      connection.provider !== provider ||
      (provider === 'SLACK' && !connection.credentialsEncrypted)
    ) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'The event source is unavailable or has the wrong provider. Reconnect it and try again.'
      );
    }
  }
  return workspace.projectId;
}

export const agentProposalAccessor = {
  get(workspaceId: string, id: string) {
    return prisma.agentProposal.findFirst({ where: { id, workspaceId } });
  },
  propose(input: ProposalWrite) {
    return prisma.$transaction(async (tx) => {
      await validate(tx, input.workspaceId, input.specification);
      const data = { specification: input.specification, sourceNames: input.sourceNames };
      if (!input.proposalId) {
        return tx.agentProposal.create({ data: { ...data, workspaceId: input.workspaceId } });
      }
      const updated = await tx.agentProposal.updateMany({
        where: {
          id: input.proposalId,
          workspaceId: input.workspaceId,
          revision: input.revision,
          agentDefinitionId: null,
        },
        data: { ...data, revision: { increment: 1 } },
      });
      if (!updated.count) {
        throw stale();
      }
      return tx.agentProposal.findUniqueOrThrow({ where: { id: input.proposalId } });
    });
  },
  create(input: ProposalWrite & { proposalId: string; revision: number }) {
    return prisma.$transaction(async (tx) => {
      // Acquire SQLite's write lock before reading the acceptance state.
      const claimed = await tx.agentProposal.updateMany({
        where: { id: input.proposalId, workspaceId: input.workspaceId, revision: input.revision },
        data: { revision: input.revision },
      });
      if (!claimed.count) {
        throw stale();
      }
      const proposal = await tx.agentProposal.findUniqueOrThrow({
        where: { id: input.proposalId },
      });
      if (proposal.agentDefinitionId) {
        if (JSON.stringify(proposal.specification) !== JSON.stringify(input.specification)) {
          throw stale();
        }
        return proposal;
      }
      const projectId = await validate(tx, input.workspaceId, input.specification);
      const { triggers, ...definition } = input.specification;
      const agent = await tx.agentDefinition.create({
        data: {
          ...definition,
          projectId,
          isEnabled: false,
          triggers: {
            create: triggers.map((trigger, index) => ({
              ...trigger,
              id: `${proposal.id}:${index}`,
              isEnabled: false,
            })),
          },
        },
      });
      return tx.agentProposal.update({
        where: { id: proposal.id },
        data: {
          specification: input.specification,
          sourceNames: input.sourceNames,
          agentDefinitionId: agent.id,
        },
      });
    });
  },
  update(input: ProposalWrite & { proposalId: string; revision: number }) {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.agentProposal.updateMany({
        where: {
          id: input.proposalId,
          workspaceId: input.workspaceId,
          revision: input.revision,
          agentDefinitionId: { not: null },
        },
        data: { revision: { increment: 1 } },
      });
      if (!claimed.count) {
        throw stale();
      }
      const proposal = await tx.agentProposal.findUniqueOrThrow({
        where: { id: input.proposalId },
      });
      if (!proposal.agentDefinitionId) {
        throw stale();
      }
      const projectId = await validate(tx, input.workspaceId, input.specification);
      const { triggers, ...definition } = input.specification;
      const agent = await tx.agentDefinition.findFirst({
        where: { id: proposal.agentDefinitionId, projectId },
      });
      if (!agent) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'The agent no longer belongs to this workspace project.'
        );
      }
      await tx.agentDefinition.update({ where: { id: agent.id }, data: definition });
      // Trigger slots keep their identity and run history when their settings change.
      for (const [index, trigger] of triggers.entries()) {
        const id = `${proposal.id}:${index}`;
        await tx.agentTrigger.upsert({
          where: { id },
          create: { ...trigger, id, agentDefinitionId: agent.id, isEnabled: false },
          update: { ...trigger, isEnabled: false },
        });
      }
      await tx.agentTrigger.updateMany({
        where: {
          agentDefinitionId: agent.id,
          id: { notIn: triggers.map((_, index) => `${proposal.id}:${index}`) },
        },
        data: { isEnabled: false },
      });
      return tx.agentProposal.update({
        where: { id: proposal.id },
        data: { specification: input.specification, sourceNames: input.sourceNames },
      });
    });
  },
  saveGitHubConnection(repositoryId: string, name: string) {
    // Repository-scoped gh identity; not a GitHub App installation credential.
    return prisma.agentConnection.upsert({
      where: { provider_externalId: { provider: 'GITHUB', externalId: `gh:${repositoryId}` } },
      create: { provider: 'GITHUB', externalId: `gh:${repositoryId}`, name },
      update: { name },
      select: { id: true, externalId: true, name: true, isEnabled: true },
    });
  },
};
