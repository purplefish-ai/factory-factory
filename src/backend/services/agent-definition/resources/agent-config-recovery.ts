import { nullablePrismaJson } from '@/backend/lib/prisma-json';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import {
  recoveryJsonNullLookup,
  type RecoveryJsonNullLookup,
} from '@/shared/schemas/recovery-json-storage.schema';
import { Prisma } from '@prisma-gen/client';
import { conflictingRecoverySourceConnections } from './agent-source-recovery-collisions';

export async function restoreAgentConfigRecovery(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  projects: ReadonlySet<string>
) {
  const nulls = recoveryJsonNullLookup(data.jsonStorage);
  const definitions = new Set<string>();
  const connections = new Set<string>();
  const triggers = new Set<string>();
  const conflictingSources = await conflictingRecoverySourceConnections(tx, data);
  for (const row of data.agentDefinition) {
    if (
      !projects.has(row.projectId) ||
      (await tx.agentDefinition.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.agentDefinition.create({
      data: { ...row, executionConfig: row.executionConfig ?? Prisma.JsonNull, isEnabled: false },
    });
    definitions.add(row.id);
  }
  for (const row of data.agentConnection) {
    // Existing connections may contain credentials; never borrow their authority.
    if (
      conflictingSources.has(row.id) ||
      (await tx.agentConnection.findUnique({ where: { id: row.id } })) ||
      (await tx.agentConnection.findUnique({
        where: { provider_externalId: { provider: row.provider, externalId: row.externalId } },
      }))
    ) {
      continue;
    }
    await tx.agentConnection.create({
      data: { ...row, isEnabled: false, credentialsEncrypted: null },
    });
    connections.add(row.id);
  }
  for (const row of data.agentTrigger) {
    if (
      !definitions.has(row.agentDefinitionId) ||
      (row.connectionId && !connections.has(row.connectionId)) ||
      (await tx.agentTrigger.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.agentTrigger.create({ data: inertTrigger(row, nulls) });
    triggers.add(row.id);
  }
  return { definitions, connections, triggers };
}

function inertTrigger(
  row: DurableRecovery['agentTrigger'][number],
  nulls: RecoveryJsonNullLookup
): Prisma.AgentTriggerUncheckedCreateInput {
  return {
    ...row,
    config: row.config ?? Prisma.JsonNull,
    isEnabled: false,
    activationState: 'PAUSED',
    activationBoundary: nullablePrismaJson(
      row.activationBoundary,
      nulls('AgentTrigger', row.id, 'activationBoundary')
    ),
    pendingActivation: nullablePrismaJson(
      row.pendingActivation,
      nulls('AgentTrigger', row.id, 'pendingActivation')
    ),
  };
}
