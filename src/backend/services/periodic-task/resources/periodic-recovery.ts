import { nullablePrismaJson } from '@/backend/lib/prisma-json';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';
import { recoveryJsonNullLookup } from '@/shared/schemas/recovery-json-storage.schema';
import { type Prisma } from '@prisma-gen/client';

export async function restorePeriodicRecovery(
  tx: Prisma.TransactionClient,
  data: DurableRecovery,
  projects: ReadonlySet<string>,
  workspaces: ReadonlySet<string>
) {
  const nulls = recoveryJsonNullLookup(data.jsonStorage);
  const tasks = new Set<string>();
  for (const row of data.periodicTask) {
    if (
      !projects.has(row.projectId) ||
      (await tx.periodicTask.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.periodicTask.create({ data: { ...row, isEnabled: false } });
    tasks.add(row.id);
  }
  for (const row of data.periodicTaskExecution) {
    if (
      !tasks.has(row.periodicTaskId) ||
      (row.workspaceId && !workspaces.has(row.workspaceId)) ||
      (await tx.periodicTaskExecution.findUnique({ where: { id: row.id } }))
    ) {
      continue;
    }
    await tx.periodicTaskExecution.create({
      data: {
        ...row,
        launchSnapshot: nullablePrismaJson(
          row.launchSnapshot,
          nulls('PeriodicTaskExecution', row.id, 'launchSnapshot')
        ),
        status: row.status === 'RUNNING' ? 'FAILED' : row.status,
        errorMessage:
          row.status === 'RUNNING'
            ? [row.errorMessage, 'Imported unfinished execution; inspect evidence before recovery']
                .filter((message) => message !== null)
                .join('\n')
            : row.errorMessage,
      },
    });
  }
  return tasks;
}
