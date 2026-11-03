import type { PeriodicConfigImportReport } from '@/shared/recovery-import-report';
import type { PeriodicConfigRecovery } from '@/shared/schemas/periodic-recovery.schema';
import type { Prisma } from '@prisma-gen/client';

export async function exportPeriodicConfigRecovery(
  tx: Prisma.TransactionClient
): Promise<PeriodicConfigRecovery> {
  const tasks = await tx.periodicTask.findMany({ orderBy: { id: 'asc' } });
  return {
    version: 1,
    tasks: tasks.map((task) => ({
      ...task,
      nextRunAt: task.nextRunAt.toISOString(),
      lastRunAt: task.lastRunAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })),
  };
}

export async function restorePeriodicConfigRecovery(
  tx: Prisma.TransactionClient,
  section: PeriodicConfigRecovery,
  acceptedProjectIds: ReadonlySet<string>
): Promise<PeriodicConfigImportReport> {
  const occupiedIds = new Set(
    (await tx.periodicTask.findMany({ select: { id: true } })).map((task) => task.id)
  );
  const report: PeriodicConfigImportReport = {
    model: 'PeriodicTask',
    imported: 0,
    skipped: 0,
    sourceEnabled: section.tasks.filter((task) => task.isEnabled).length,
    restoredDisabled: 0,
    reasons: { EXISTING_IDENTITY: 0, INCOMPLETE_DEPENDENCY: 0 },
  };
  for (const task of section.tasks) {
    const reason = occupiedIds.has(task.id)
      ? 'EXISTING_IDENTITY'
      : !acceptedProjectIds.has(task.projectId)
        ? 'INCOMPLETE_DEPENDENCY'
        : null;
    if (reason) {
      report.skipped++;
      report.reasons[reason]++;
      continue;
    }
    await tx.periodicTask.create({
      data: {
        ...task,
        isEnabled: false,
        nextRunAt: new Date(task.nextRunAt),
        lastRunAt: task.lastRunAt === null ? null : new Date(task.lastRunAt),
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt),
      },
    });
    report.imported++;
    report.restoredDisabled++;
  }
  return report;
}
