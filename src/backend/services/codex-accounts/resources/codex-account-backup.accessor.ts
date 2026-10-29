import { createHash } from 'node:crypto';
import { prisma } from '@/backend/db';
import {
  codexAccountMetadataSchema,
  type CodexAccountMetadata,
} from '@/shared/codex-account-backup';
import type { Prisma } from '@prisma-gen/client';

function restoredIdentity(key: string | null, id: string): string | null {
  const fallback = key?.match(/^native-email:([a-f0-9]{64})/);
  return fallback ? `native-email:${fallback[1]}:imported:${id}` : key;
}
async function restoreAccount(
  tx: Prisma.TransactionClient,
  row: CodexAccountMetadata
): Promise<string> {
  // Only a verified provider scope can automatically reuse another local account.
  if (row.identityKey && !row.identityKey.startsWith('native-email:')) {
    const matching = await tx.codexAccount.findUnique({ where: { identityKey: row.identityKey } });
    if (matching) {
      return matching.id;
    }
  }
  const existing = await tx.codexAccount.findUnique({ where: { id: row.id } });
  if (
    existing?.kind === 'MANAGED' &&
    existing.identityKey === row.identityKey &&
    row.identityKey?.includes(':imported:')
  ) {
    return existing.id;
  }
  // An imported native home must never adopt this machine's current login.
  const isolatedId = `imported-codex-${createHash('sha256')
    .update(JSON.stringify([row.id, row.identityKey]))
    .digest('hex')
    .slice(0, 24)}`;
  const id = row.kind === 'NATIVE_DEFAULT' || existing ? isolatedId : row.id;
  const identityKey = restoredIdentity(row.identityKey, id);
  const restored = await tx.codexAccount.findUnique({ where: { id } });
  if (restored) {
    if (restored.kind !== 'MANAGED' || restored.identityKey !== identityKey) {
      throw new Error('Imported Codex account conflicts with a local profile');
    }
    return id;
  }
  await tx.codexAccount.create({
    data: {
      ...row,
      id,
      identityKey,
      kind: 'MANAGED',
      label: (row.kind === 'NATIVE_DEFAULT' ? `Imported ${row.label}` : row.label).slice(0, 100),
    },
  });
  return id;
}
export const codexAccountBackupAccessor = {
  async exportMetadata(): Promise<CodexAccountMetadata[]> {
    return codexAccountMetadataSchema
      .array()
      .parse(await prisma.codexAccount.findMany({ orderBy: { createdAt: 'asc' } }));
  },
  async restoreMetadata(tx: Prisma.TransactionClient, input: CodexAccountMetadata[]) {
    const ids = new Map<string, string>();
    for (const row of codexAccountMetadataSchema.array().parse(input)) {
      if (ids.has(row.id)) {
        throw new Error('Duplicate Codex account in backup');
      }
      ids.set(row.id, await restoreAccount(tx, row));
    }
    return ids;
  },
};
