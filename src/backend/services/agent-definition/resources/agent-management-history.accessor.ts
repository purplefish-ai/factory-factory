import { z } from 'zod';
import { prisma } from '@/backend/db';
import { ApplicationError } from '@/backend/lib/application-error';
import { ownedAgent, pageAfter, type ManagementCursor } from './agent-management.accessor';

const runSelect = {
  id: true,
  agentDefinitionId: true,
  triggerId: true,
  eventId: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  status: true,
  launchPhase: true,
  reasonCode: true,
  attemptCount: true,
  attemptGeneration: true,
  nextAttemptAt: true,
  expiresAt: true,
  launchPreparation: true,
  result: true,
  reservedWorkspaceId: true,
  reservedSessionId: true,
  workspaceId: true,
  initialDelivery: {
    select: { state: true, sendingAt: true, acceptedAt: true, finishedAt: true, evidence: true },
  },
} as const;
export const agentManagementHistoryAccessor = {
  runs(input: { projectId: string; agentId: string; limit: number }, cursor?: ManagementCursor) {
    return prisma.$transaction(async (tx) => {
      await ownedAgent(tx, input.projectId, input.agentId);
      return tx.agentRun.findMany({
        where: { agentDefinitionId: input.agentId, ...pageAfter(cursor) },
        select: runSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      });
    });
  },
  evaluations(
    input: { projectId: string; agentId: string; limit: number },
    cursor?: ManagementCursor
  ) {
    return prisma.$transaction(async (tx) => {
      await ownedAgent(tx, input.projectId, input.agentId);
      return tx.agentEvaluation.findMany({
        where: { agentDefinitionId: input.agentId, ...pageAfter(cursor) },
        select: {
          id: true,
          eventId: true,
          triggerId: true,
          runId: true,
          createdAt: true,
          status: true,
          reasonCode: true,
          definitionRevision: true,
          triggerRevision: true,
          activationGeneration: true,
          attemptCount: true,
          nextAttemptAt: true,
          expiresAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      });
    });
  },
  async navigationSummary(projectId: string) {
    if (!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) {
      throw new ApplicationError('NOT_FOUND', 'Project not found.');
    }
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*) AS totalCount, COALESCE(SUM(CASE WHEN (
        SELECT r.status FROM AgentRun r WHERE r.agentDefinitionId = d.id AND r.triggerId IS NOT NULL
          AND r.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
        ORDER BY COALESCE(r.completedAt, r.createdAt) DESC, r.id DESC LIMIT 1
      ) = 'FAILED' THEN 1 ELSE 0 END), 0) AS failedCount
      FROM AgentDefinition d WHERE d.projectId = ${projectId}`;
    const count = z.union([z.number(), z.bigint()]).transform(Number);
    return z.tuple([z.object({ totalCount: count, failedCount: count })]).parse(rows)[0];
  },
  async originRun(input: { projectId: string; workspaceId: string; runId: string }) {
    const run = await prisma.agentRun.findFirst({
      where: { id: input.runId, agentDefinition: { projectId: input.projectId } },
      select: runSelect,
    });
    if (!run) {
      return null;
    }
    if (
      run.reservedWorkspaceId !== input.workspaceId ||
      (run.workspaceId !== null && run.workspaceId !== input.workspaceId)
    ) {
      throw new ApplicationError('NOT_FOUND', 'Event origin does not match this workspace.');
    }
    return run;
  },
};
