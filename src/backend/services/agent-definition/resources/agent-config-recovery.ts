import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import { Prisma } from '@prisma-gen/client';

export async function restoreAgentConfigRecovery(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  projects: ReadonlySet<string>
) {
  const definitions = new Set<string>();
  const connections = new Set<string>();
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
    await tx.agentTrigger.create({
      data: {
        ...row,
        config: row.config ?? Prisma.JsonNull,
        isEnabled: false,
        activationState: 'PAUSED',
        activationBoundary: Prisma.DbNull,
        pendingActivation: Prisma.DbNull,
      },
    });
  }
}
