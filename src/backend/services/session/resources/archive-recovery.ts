import type { Prisma } from '@prisma-gen/client';
import {
  closedSessionAccessor,
  type StageClosedSessionRecoveryInput,
} from './closed-session.accessor';

/** The ClosedSession owner remains the only Prisma writer, including import. */
export async function stageSessionArchiveRecovery(
  tx: Prisma.TransactionClient,
  rows: readonly StageClosedSessionRecoveryInput[],
  importedWorkspaceIds: ReadonlySet<string>
): Promise<string[]> {
  const imported: string[] = [];
  for (const row of rows) {
    if (!importedWorkspaceIds.has(row.workspaceId)) {
      continue;
    }
    if (await closedSessionAccessor.stageRecovery(tx, row)) {
      imported.push(row.id);
    }
  }
  return imported;
}
