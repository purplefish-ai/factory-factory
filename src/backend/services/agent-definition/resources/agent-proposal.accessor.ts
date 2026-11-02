import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentSourceValidation } from '@/shared/agent-management';
import type { AgentSpecification } from '@/shared/agent-proposal';
import type { Prisma } from '@prisma-gen/client';
import { validateManagementSources } from './agent-management-write';
import { agentRevisionAccessor } from './agent-revision.accessor';

type Transaction = Prisma.TransactionClient;
export type ProposalWrite = {
  workspaceId: string;
  proposalId?: string;
  revision?: number;
  specification: AgentSpecification;
  sourceNames: Record<string, string>;
  evidence?: AgentSourceValidation;
};
const stale = () =>
  new ApplicationError('CONFLICT', 'This proposal changed. Reload it before continuing.');

async function validate(
  tx: Transaction,
  workspaceId: string,
  spec: AgentSpecification,
  evidence?: AgentSourceValidation
) {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    include: { project: true },
  });
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
  await validateManagementSources(tx, workspace.projectId, spec, evidence);
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

function ownedTrigger(proposalId: string, trigger: AgentSpecification['triggers'][number]) {
  const { id, ...settings } = trigger;
  if (!id) {
    throw new ApplicationError(
      'INVALID_INPUT',
      'Preserve event IDs from the saved proposal before creating or editing an agent.'
    );
  }
  return { ...settings, id: `${proposalId}:${id}`, isEnabled: false as const };
}

export const agentProposalAccessor = {
  get(workspaceId: string, id: string) {
    return prisma.agentProposal.findFirst({ where: { id, workspaceId } });
  },
  propose(input: ProposalWrite) {
    return prisma.$transaction(async (tx) => {
      await validate(tx, input.workspaceId, input.specification, input.evidence);
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
      const projectId = await validate(tx, input.workspaceId, input.specification, input.evidence);
      const { triggers, ...definition } = input.specification;
      const agent = await tx.agentDefinition.create({
        data: {
          ...definition,
          projectId,
          isEnabled: false,
          triggers: {
            create: triggers.map((trigger) => ({
              ...ownedTrigger(proposal.id, trigger),
              isConfigured: true,
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
      const projectId = await validate(tx, input.workspaceId, input.specification, input.evidence);
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
      await agentRevisionAccessor.reviseDefinition(
        tx,
        agent.id,
        definition,
        triggers.map((trigger) => ownedTrigger(proposal.id, trigger))
      );
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
