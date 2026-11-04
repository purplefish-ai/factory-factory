import type { SlackConnectionsImportReport } from '@/shared/recovery-import-report';
import {
  slackConnectionsRecoverySchema,
  type SlackConnectionsRecovery,
} from '@/shared/schemas/slack-connections-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

export async function exportSlackConnectionsRecovery(
  tx: Prisma.TransactionClient
): Promise<SlackConnectionsRecovery> {
  const rows = await tx.agentConnection.findMany({
    where: { provider: 'SLACK' },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      provider: true,
      externalId: true,
      name: true,
      isEnabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return slackConnectionsRecoverySchema.parse({
    version: 1,
    connections: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function planSlackConnectionsRecovery(
  tx: Prisma.TransactionClient,
  section: SlackConnectionsRecovery
): Promise<
  readonly {
    row: SlackConnectionsRecovery['connections'][number];
    reason: 'EXISTING_IDENTITY' | null;
  }[]
> {
  const occupied = await tx.agentConnection.findMany({
    select: { id: true, provider: true, externalId: true },
  });
  const ids = new Set(occupied.map((row) => row.id));
  const teams = new Set(
    occupied.filter((row) => row.provider === 'SLACK').map((row) => row.externalId)
  );
  return section.connections.map((row) => ({
    row,
    reason: ids.has(row.id) || teams.has(row.externalId) ? ('EXISTING_IDENTITY' as const) : null,
  }));
}

export async function restoreSlackConnectionsRecovery(
  tx: Prisma.TransactionClient,
  plan: Awaited<ReturnType<typeof planSlackConnectionsRecovery>>
): Promise<SlackConnectionsImportReport> {
  const report: SlackConnectionsImportReport = {
    model: 'AgentConnection',
    imported: 0,
    skipped: 0,
    sourceEnabled: plan.filter(({ row }) => row.isEnabled).length,
    restoredDisabled: 0,
    reasons: { EXISTING_IDENTITY: 0 },
  };
  for (const { row, reason } of plan) {
    if (reason) {
      report.skipped++;
      report.reasons[reason]++;
      continue;
    }
    await tx.agentConnection.create({
      data: {
        ...row,
        isEnabled: false,
        credentialsEncrypted: null,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      },
    });
    report.imported++;
    report.restoredDisabled++;
  }
  return report;
}
