import { codexAccountBackupAccessor } from '@/backend/services/codex-accounts/resources/codex-account-backup.accessor';
import type { CodexAccountMetadata } from '@/shared/codex-account-backup';
import type { Prisma } from '@prisma-gen/client';
export const exportCodexAccountMetadata = () => codexAccountBackupAccessor.exportMetadata();
export const restoreCodexAccountMetadata = (
  tx: Prisma.TransactionClient,
  rows: CodexAccountMetadata[]
) => codexAccountBackupAccessor.restoreMetadata(tx, rows);

export function resolveRestoredCodexAccountId(id: string | null, ids: ReadonlyMap<string, string>) {
  if (id === null) {
    return null;
  }
  const restored = ids.get(id);
  if (!restored) {
    throw new Error('Backup is missing Codex account metadata');
  }
  return restored;
}
