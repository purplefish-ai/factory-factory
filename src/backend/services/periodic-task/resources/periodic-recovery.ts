import { z } from 'zod';
import type {
  PeriodicHistoryImportReport,
  PeriodicConfigImportReport,
} from '@/shared/recovery-import-report';
import {
  periodicHistoryRecoverySchema,
  type PeriodicHistoryRecovery,
  type PeriodicConfigRecovery,
} from '@/shared/schemas/periodic-recovery.schema';
import { Prisma } from '@prisma-gen/client';

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

export async function readPeriodicConfigRecoveryIds(
  tx: Prisma.TransactionClient
): Promise<ReadonlySet<string>> {
  return new Set((await tx.periodicTask.findMany({ select: { id: true } })).map((task) => task.id));
}

export async function restorePeriodicConfigRecovery(
  tx: Prisma.TransactionClient,
  section: PeriodicConfigRecovery,
  acceptedProjectIds: ReadonlySet<string>,
  occupiedIds: ReadonlySet<string>
): Promise<{ report: PeriodicConfigImportReport; createdTaskIds: Set<string> }> {
  const createdTaskIds = new Set<string>();
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
    createdTaskIds.add(task.id);
    report.imported++;
    report.restoredDisabled++;
  }
  return { report, createdTaskIds };
}

export async function exportPeriodicHistoryRecovery(tx: Prisma.TransactionClient) {
  const executions = await tx.periodicTaskExecution.findMany({ orderBy: { id: 'asc' } });
  const markers = z
    .array(z.strictObject({ id: z.string() }))
    .parse(
      await tx.$queryRaw`SELECT id FROM "PeriodicTaskExecution" WHERE json_type("launchSnapshot") = 'null' ORDER BY id`
    );
  return periodicHistoryRecoverySchema.parse({
    version: 1,
    executions: executions.map((row) => ({
      ...row,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    })),
    jsonStorage: markers.map((row) => ({
      model: 'PeriodicTaskExecution',
      identity: [row.id],
      field: 'launchSnapshot',
    })),
  });
}
export async function planPeriodicHistoryRecovery(
  tx: Prisma.TransactionClient,
  section: PeriodicHistoryRecovery,
  plannedTaskIds: ReadonlySet<string>,
  plannedWorkspaceIds: ReadonlySet<string>
) {
  const occupied = await tx.periodicTaskExecution.findMany({
    select: { id: true, workspaceId: true },
  });
  const ids = new Set(occupied.map((row) => row.id));
  const slots = new Set(
    occupied.flatMap((row) => (row.workspaceId === null ? [] : [row.workspaceId]))
  );
  return {
    jsonNullIds: new Set(section.jsonStorage.map((marker) => marker.identity[0])),
    rows: section.executions.map((row) => {
      const dependenciesAvailable =
        plannedTaskIds.has(row.periodicTaskId) &&
        (row.workspaceId === null || plannedWorkspaceIds.has(row.workspaceId));
      const reason = ids.has(row.id)
        ? ('EXISTING_IDENTITY' as const)
        : row.workspaceId !== null && slots.has(row.workspaceId)
          ? ('CONFLICTING_IDENTITY_OR_PARENT' as const)
          : !dependenciesAvailable
            ? ('INCOMPLETE_DEPENDENCY' as const)
            : null;
      return { row, dependenciesAvailable, reason };
    }),
  };
}
function historicalExecutionData(
  row: PeriodicHistoryRecovery['executions'][number],
  jsonNullIds: ReadonlySet<string>
) {
  const running = row.status === 'RUNNING';
  const diagnostic =
    'Recovery import: original status RUNNING. Marked FAILED as historical only; provider outcome is unknown and this execution will not be resumed.';
  return {
    ...row,
    launchSnapshot:
      row.launchSnapshot ?? (jsonNullIds.has(row.id) ? Prisma.JsonNull : Prisma.DbNull),
    status: running ? 'FAILED' : row.status,
    errorMessage: running
      ? row.errorMessage === null
        ? diagnostic
        : `${row.errorMessage}\n\n${diagnostic}`
      : row.errorMessage,
    startedAt: new Date(row.startedAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
  };
}

export async function restorePeriodicHistoryRecovery(
  tx: Prisma.TransactionClient,
  plan: Awaited<ReturnType<typeof planPeriodicHistoryRecovery>>,
  createdTaskIds: ReadonlySet<string>,
  createdWorkspaceIds: ReadonlySet<string>
): Promise<PeriodicHistoryImportReport> {
  const report: PeriodicHistoryImportReport = {
    model: 'PeriodicTaskExecution',
    imported: 0,
    skipped: 0,
    sourceRunning: plan.rows.filter(({ row }) => row.status === 'RUNNING').length,
    restoredHistoricalFailed: 0,
    restoredSettled: 0,
    reasons: { EXISTING_IDENTITY: 0, CONFLICTING_IDENTITY_OR_PARENT: 0, INCOMPLETE_DEPENDENCY: 0 },
  };
  for (const { row, reason, dependenciesAvailable } of plan.rows) {
    const actual =
      createdTaskIds.has(row.periodicTaskId) &&
      (row.workspaceId === null || createdWorkspaceIds.has(row.workspaceId));
    if (actual !== dependenciesAvailable) {
      throw new Error('Periodic history dependencies disagree with admission');
    }
    if (reason) {
      report.skipped++;
      report.reasons[reason]++;
      continue;
    }
    const running = row.status === 'RUNNING';
    await tx.periodicTaskExecution.create({ data: historicalExecutionData(row, plan.jsonNullIds) });
    report.imported++;
    if (running) {
      report.restoredHistoricalFailed++;
    } else {
      report.restoredSettled++;
    }
  }
  return report;
}
