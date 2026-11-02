import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@/backend/db';
import { eventAgentExecutionSchema, type EventSessionCreation } from '@/shared/event-agent-launch';
import { remapRecoveryExecution } from '@/shared/recovery-account-identity';
import { retainedReferenceAllowed, type RecoveryImportedIds } from '@/shared/recovery-graph';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import type { Prisma, AgentRun, AgentSession } from '@prisma-gen/client';

export const agentSessionLaunchOriginAccessor = {
  find(tx: Prisma.TransactionClient, input: EventSessionCreation) {
    return tx.agentSessionLaunchOrigin.findFirst({
      where: { OR: [{ runId: input.runId }, { sessionId: input.id }] },
    });
  },
  create(tx: Prisma.TransactionClient, input: EventSessionCreation) {
    return tx.agentSessionLaunchOrigin.create({
      data: {
        runId: input.runId,
        sessionId: input.id,
        workspaceId: input.workspaceId,
        execution: input.execution,
      },
    });
  },
  async findBySessionId(sessionId: string) {
    const origin = await prisma.agentSessionLaunchOrigin.findUnique({ where: { sessionId } });
    return origin
      ? { ...origin, execution: eventAgentExecutionSchema.parse(origin.execution) }
      : null;
  },
};

export async function restoreRecoverySessionOrigins(
  tx: Prisma.TransactionClient,
  data: ExportData['data'],
  ids: RecoveryImportedIds,
  accounts: ReadonlyMap<string, string>
) {
  const sourceSessions = new Set(data.agentSessions.map((row) => row.id));
  const sourceWorkspaces = new Set(data.workspaces.map((row) => row.id));
  const sourceRuns = new Set(data.durable?.agentRun.map((row) => row.id));
  for (const row of data.durable?.agentSessionLaunchOrigin ?? []) {
    if (
      !(
        retainedReferenceAllowed(
          sourceSessions,
          ids.sessions,
          row.sessionId,
          !!(await tx.agentSession.findUnique({ where: { id: row.sessionId } }))
        ) &&
        retainedReferenceAllowed(
          sourceWorkspaces,
          ids.workspaces,
          row.workspaceId,
          !!(await tx.workspace.findUnique({ where: { id: row.workspaceId } }))
        ) &&
        retainedReferenceAllowed(
          sourceRuns,
          ids.runs,
          row.runId,
          !!(await tx.agentRun.findUnique({ where: { id: row.runId } }))
        )
      )
    ) {
      continue;
    }
    if (
      await tx.agentSessionLaunchOrigin.findFirst({
        where: { OR: [{ runId: row.runId }, { sessionId: row.sessionId }] },
      })
    ) {
      continue;
    }
    const execution = remapRecoveryExecution(row.execution, accounts);
    assertRecoveryOriginBindings(
      row,
      execution,
      await tx.agentSession.findUnique({ where: { id: row.sessionId } }),
      await tx.agentRun.findUnique({ where: { id: row.runId } })
    );
    await tx.agentSessionLaunchOrigin.create({ data: { ...row, execution } });
  }
}

function assertRecoveryOriginBindings(
  origin: { sessionId: string; workspaceId: string },
  execution: Prisma.InputJsonValue,
  session: Pick<AgentSession, 'workspaceId'> | null,
  run: Pick<AgentRun, 'reservedSessionId' | 'workspaceId' | 'effectiveExecution'> | null
) {
  if (
    (session && session.workspaceId !== origin.workspaceId) ||
    (run?.reservedSessionId && run.reservedSessionId !== origin.sessionId) ||
    (run?.workspaceId && run.workspaceId !== origin.workspaceId) ||
    (run?.effectiveExecution && !isDeepStrictEqual(run.effectiveExecution, execution))
  ) {
    throw new Error('Imported session origin conflicts with its retained launch binding');
  }
}
