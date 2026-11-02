import { z } from 'zod';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  type agentSavedUpdateSchema,
  type AgentSourceValidation,
  type SavedAgentSpecification,
} from '@/shared/agent-management';
import type { Prisma } from '@prisma-gen/client';
import { ledgerTransaction } from './agent-ledger-transaction';
import {
  proposalSpecification,
  resolveSavedTriggerIds,
  validateManagementSources,
} from './agent-management-write';
import { agentRevisionAccessor } from './agent-revision.accessor';

export const managementTriggerInclude = {
  connection: {
    select: {
      name: true,
      isEnabled: true,
      provider: true,
      externalId: true,
      sourceState: { select: { health: true } },
    },
  },
} as const;
export const managementCursorSchema = z.strictObject({
  projectId: z.string(),
  agentId: z.string().optional(),
  kind: z.enum(['list', 'retained', 'runs', 'evaluations']),
  createdAt: z.iso.datetime(),
  id: z.string().min(1).max(256),
});
export type ManagementCursor = z.infer<typeof managementCursorSchema>;
export function pageAfter(cursor?: ManagementCursor) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : {};
}
export async function ownedAgent(tx: Prisma.TransactionClient, projectId: string, agentId: string) {
  const agent = await tx.agentDefinition.findFirst({ where: { id: agentId, projectId } });
  if (!agent) {
    throw new ApplicationError('NOT_FOUND', 'Agent not found in this project.');
  }
  return agent;
}
async function get(
  tx: Prisma.TransactionClient,
  input: { projectId: string; agentId: string },
  cursor?: ManagementCursor
) {
  const definition = await ownedAgent(tx, input.projectId, input.agentId);
  const unknown = await tx.agentTrigger.findFirst({
    where: { agentDefinitionId: definition.id, isConfigured: null },
    select: { id: true },
  });
  const configured = unknown
    ? []
    : await tx.agentTrigger.findMany({
        where: { agentDefinitionId: definition.id, isConfigured: true },
        orderBy: { id: 'asc' },
        take: 21,
        include: managementTriggerInclude,
      });
  const retained = await tx.agentTrigger.findMany({
    where: {
      agentDefinitionId: definition.id,
      ...(unknown ? {} : { OR: [{ isConfigured: false }, { isConfigured: null }] }),
      AND: pageAfter(cursor),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 101,
    include: managementTriggerInclude,
  });
  return { definition, unknown: Boolean(unknown), configured, retained };
}
export const agentManagementAccessor = {
  checkSources(
    projectId: string,
    specification: SavedAgentSpecification,
    evidence: AgentSourceValidation
  ) {
    return prisma.$transaction((tx) =>
      validateManagementSources(tx, projectId, specification, evidence)
    );
  },
  get(input: { projectId: string; agentId: string }, cursor?: ManagementCursor) {
    return prisma.$transaction((tx) => get(tx, input, cursor));
  },
  async list(projectId: string, limit: number, cursor?: ManagementCursor) {
    if (!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) {
      throw new ApplicationError('NOT_FOUND', 'Project not found.');
    }
    return prisma.agentDefinition.findMany({
      where: { projectId, ...pageAfter(cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
  },
  updateSaved(input: z.infer<typeof agentSavedUpdateSchema>, evidence: AgentSourceValidation) {
    return ledgerTransaction(async (tx) => {
      await ownedAgent(tx, input.projectId, input.agentId);
      const claimed = await tx.agentDefinition.updateMany({
        where: {
          id: input.agentId,
          projectId: input.projectId,
          managementRevision: input.expectedManagementRevision,
        },
        data: { managementRevision: input.expectedManagementRevision },
      });
      if (!claimed.count) {
        throw new ApplicationError('CONFLICT', 'This agent changed. Reload it before saving.');
      }
      await validateManagementSources(tx, input.projectId, input.specification, evidence);
      const proposal = await tx.agentProposal.findUnique({
        where: { agentDefinitionId: input.agentId },
      });
      const triggers = await resolveSavedTriggerIds(
        tx,
        input.agentId,
        input.specification,
        proposal?.id
      );
      const { triggers: _triggers, ...definition } = input.specification;
      await agentRevisionAccessor.reviseDefinition(tx, input.agentId, definition, triggers);
      if (proposal) {
        if (proposal.revision >= 2_147_483_647) {
          throw new ApplicationError('CONFLICT', 'The proposal revision is exhausted.');
        }
        await tx.agentProposal.update({
          where: { id: proposal.id },
          data: {
            revision: { increment: 1 },
            specification: proposalSpecification({ ...definition, triggers }, proposal.id),
            sourceNames: evidence.sourceNames,
          },
        });
      }
      return get(tx, input);
    });
  },
};
