import type { AutomationDefinitionsImportReport } from '@/shared/recovery-import-report';
import {
  automationDefinitionsRecoverySchema,
  type AutomationDefinitionsRecovery,
} from '@/shared/schemas/automation-definitions-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

export async function exportAutomationDefinitionsRecovery(tx: Prisma.TransactionClient) {
  const rows = await tx.agentDefinition.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      projectId: true,
      name: true,
      instructions: true,
      isEnabled: true,
      executionConfig: true,
      definitionRevision: true,
      managementRevision: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return automationDefinitionsRecoverySchema.parse({
    version: 1,
    definitions: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function planAutomationDefinitionsRecovery(
  tx: Prisma.TransactionClient,
  section: AutomationDefinitionsRecovery,
  plannedCreatedProjectIds: ReadonlySet<string>
) {
  const occupied = new Set(
    (await tx.agentDefinition.findMany({ select: { id: true } })).map((row) => row.id)
  );
  return section.definitions.map((row) => {
    const dependenciesAvailable = plannedCreatedProjectIds.has(row.projectId);
    const reason = occupied.has(row.id)
      ? ('EXISTING_IDENTITY' as const)
      : !dependenciesAvailable
        ? ('INCOMPLETE_DEPENDENCY' as const)
        : null;
    return { row, dependenciesAvailable, reason };
  });
}

export async function restoreAutomationDefinitionsRecovery(
  tx: Prisma.TransactionClient,
  plan: Awaited<ReturnType<typeof planAutomationDefinitionsRecovery>>,
  actualCreatedProjectIds: ReadonlySet<string>
): Promise<AutomationDefinitionsImportReport> {
  const report: AutomationDefinitionsImportReport = {
    model: 'AgentDefinition',
    imported: 0,
    skipped: 0,
    sourceEnabled: plan.filter(({ row }) => row.isEnabled).length,
    restoredDisabled: 0,
    reasons: { EXISTING_IDENTITY: 0, INCOMPLETE_DEPENDENCY: 0 },
  };
  for (const { row, dependenciesAvailable, reason } of plan) {
    if (actualCreatedProjectIds.has(row.projectId) !== dependenciesAvailable) {
      throw new Error('Automation definition dependencies disagree with admission');
    }
    if (reason) {
      report.skipped++;
      report.reasons[reason]++;
      continue;
    }
    await tx.agentDefinition.create({
      data: {
        ...row,
        isEnabled: false,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      },
    });
    report.imported++;
    report.restoredDisabled++;
  }
  return report;
}
