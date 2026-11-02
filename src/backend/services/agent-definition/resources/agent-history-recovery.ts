import { nullablePrismaJson } from '@/backend/lib/prisma-json';
import { validateRecoveryExecution } from '@/shared/recovery-account-identity';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import {
  recoveryJsonNullLookup,
  type RecoveryJsonNullLookup,
} from '@/shared/schemas/recovery-json-storage.schema';
import { Prisma } from '@prisma-gen/client';
import { restoreRecoveryEvents } from './agent-event.accessor';
import { restoreRecoverySources } from './agent-source.accessor';

type Parents = {
  definitions: ReadonlySet<string>;
  connections: ReadonlySet<string>;
  triggers: ReadonlySet<string>;
};
type Run = DurableRecovery['agentRun'][number];

async function reservationConflicts(
  tx: Prisma.TransactionClient,
  run: Run,
  workspaces: ReadonlySet<string>
) {
  if (run.workspaceId && !workspaces.has(run.workspaceId)) {
    return true;
  }
  if (
    run.reservedWorkspaceId &&
    !workspaces.has(run.reservedWorkspaceId) &&
    (await tx.workspace.findUnique({ where: { id: run.reservedWorkspaceId } }))
  ) {
    return true;
  }
  if (run.reservedSessionId) {
    const session = await tx.agentSession.findUnique({ where: { id: run.reservedSessionId } });
    if (session && !workspaces.has(session.workspaceId)) {
      return true;
    }
  }
  return false;
}
async function conflictingDelivery(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  runId: string
) {
  const row = data.agentInitialDelivery.find((delivery) => delivery.runId === runId);
  return (
    row &&
    (await tx.agentInitialDelivery.findFirst({
      where: {
        OR: [
          { id: row.id },
          { runId },
          { sendAttemptId: row.sendAttemptId },
          { messageId: row.messageId },
        ],
      },
    }))
  );
}
function inertRunData(
  row: Run,
  nulls: RecoveryJsonNullLookup
): Prisma.AgentRunUncheckedCreateInput {
  const unresolved = row.status === 'QUEUED' || row.status === 'RUNNING';
  return {
    ...row,
    status: unresolved ? 'CANCELLED' : row.status,
    launchPhase: unresolved ? 'NEEDS_ATTENTION' : row.launchPhase,
    reasonCode: unresolved ? `IMPORTED_${row.status}_REQUIRES_REVIEW` : row.reasonCode,
    errorMessage: unresolved
      ? [
          row.errorMessage,
          `Imported ${row.status}/${row.launchPhase}; original reason: ${row.reasonCode ?? '(none)'}. No automatic recovery permitted.`,
        ]
          .filter((message) => message !== null)
          .join('\n')
      : row.errorMessage,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    definitionSnapshot: row.definitionSnapshot ?? Prisma.JsonNull,
    triggerSnapshot: nullablePrismaJson(
      row.triggerSnapshot,
      nulls('AgentRun', row.id, 'triggerSnapshot')
    ),
    input: row.input ?? Prisma.JsonNull,
    result: nullablePrismaJson(row.result, nulls('AgentRun', row.id, 'result')),
    effectiveExecution:
      row.effectiveExecution === null
        ? nullablePrismaJson(null, nulls('AgentRun', row.id, 'effectiveExecution'))
        : validateRecoveryExecution(row.effectiveExecution),
    launchPreparation: nullablePrismaJson(
      row.launchPreparation,
      nulls('AgentRun', row.id, 'launchPreparation')
    ),
  };
}

async function restoreRuns(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  parents: Parents,
  events: ReadonlySet<string>,
  workspaces: ReadonlySet<string>
) {
  const nulls = recoveryJsonNullLookup(data.jsonStorage);
  const runs = new Set<string>();
  for (const row of data.agentRun) {
    if (
      !parents.definitions.has(row.agentDefinitionId) ||
      (row.triggerId && !parents.triggers.has(row.triggerId)) ||
      (row.eventId && !events.has(row.eventId))
    ) {
      continue;
    }
    if (
      (await tx.agentRun.findUnique({ where: { id: row.id } })) ||
      (await reservationConflicts(tx, row, workspaces)) ||
      (await conflictingDelivery(tx, data, row.id))
    ) {
      continue;
    }
    await tx.agentRun.create({ data: inertRunData(row, nulls) });
    runs.add(row.id);
  }
  return runs;
}
async function restoreRunEvidence(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  parents: Parents,
  events: ReadonlySet<string>,
  runs: ReadonlySet<string>
) {
  const nulls = recoveryJsonNullLookup(data.jsonStorage);
  for (const row of data.agentInitialDelivery) {
    if (!runs.has(row.runId)) {
      continue;
    }
    await tx.agentInitialDelivery.create({
      data: {
        ...row,
        state: ['FINISHED', 'ACCEPTED'].includes(row.state) ? row.state : 'AMBIGUOUS',
        evidence: nullablePrismaJson(
          row.evidence,
          nulls('AgentInitialDelivery', row.id, 'evidence')
        ),
      },
    });
  }
  for (const row of data.agentEvaluation) {
    if (
      !(
        parents.definitions.has(row.agentDefinitionId) &&
        parents.triggers.has(row.triggerId) &&
        events.has(row.eventId)
      ) ||
      (row.runId && !runs.has(row.runId)) ||
      (await tx.agentEvaluation.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.agentEvaluation.create({
      data: {
        ...row,
        ...(row.status === 'MATCHED' && row.runId === null
          ? {
              status: 'SKIPPED' as const,
              reasonCode: 'IMPORTED_MATCHED_REQUIRES_REVIEW',
              explanation: `Imported MATCHED decision held for review; original reason: ${row.reasonCode}.\n${row.explanation}`,
            }
          : {}),
        nextAttemptAt: null,
        configurationSnapshot: row.configurationSnapshot ?? Prisma.JsonNull,
        classifier: nullablePrismaJson(
          row.classifier,
          nulls('AgentEvaluation', row.id, 'classifier')
        ),
      },
    });
  }
}

export async function restoreAgentHistoryRecovery(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  parents: Parents,
  workspaces: ReadonlySet<string>
) {
  await restoreRecoverySources(tx, data, parents.connections);
  const events = await restoreRecoveryEvents(tx, data, parents.connections);
  const runs = await restoreRuns(tx, data, parents, events, workspaces);
  await restoreRunEvidence(tx, data, parents, events, runs);
  for (const row of data.agentProposal) {
    if (
      !workspaces.has(row.workspaceId) ||
      (row.agentDefinitionId && !parents.definitions.has(row.agentDefinitionId)) ||
      (await tx.agentProposal.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.agentProposal.create({
      data: {
        ...row,
        specification: row.specification ?? Prisma.JsonNull,
        sourceNames: row.sourceNames ?? Prisma.JsonNull,
      },
    });
  }
  return runs;
}
