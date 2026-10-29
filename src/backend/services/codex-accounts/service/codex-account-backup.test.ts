import { expect, it } from 'vitest';
import { codexAccountMetadataSchema } from '@/shared/codex-account-backup';
import type { Prisma } from '@prisma-gen/client';
import { restoreCodexAccountMetadata } from './codex-account-backup';

function fixture(
  initial: Array<{
    id: string;
    identityKey: string | null;
    kind: 'MANAGED' | 'NATIVE_DEFAULT';
    label: string;
    enabled: boolean;
  }> = []
) {
  const rows = [...initial];
  const tx = {
    codexAccount: {
      findUnique: ({ where }: { where: { id?: string; identityKey?: string } }) =>
        Promise.resolve(
          rows.find((row) =>
            where.id ? row.id === where.id : row.identityKey === where.identityKey
          ) ?? null
        ),
      create: ({ data }: { data: (typeof rows)[number] }) => {
        rows.push(data);
        return Promise.resolve(data);
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { rows, tx };
}
const source = {
  id: 'account-b',
  label: 'Work',
  kind: 'MANAGED' as const,
  enabled: true,
  identityKey: 'a'.repeat(64),
};
it('restores an isolated unavailable account row before session binding without credentials', async () => {
  const f = fixture();
  const ids = await restoreCodexAccountMetadata(f.tx, [source]);
  expect(ids.get(source.id)).toBe(source.id);
  expect(f.rows).toEqual([source]);
});
it('reuses a verified matching identity instead of counting its quota twice', async () => {
  const current = { ...source, id: 'local-account' };
  const f = fixture([current]);
  const ids = await restoreCodexAccountMetadata(f.tx, [source]);
  expect(ids.get(source.id)).toBe(current.id);
  expect(f.rows).toEqual([current]);
});
it('does not map imported native sessions onto the current native login', async () => {
  const current = {
    id: 'codex-native-default',
    label: 'Native default',
    kind: 'NATIVE_DEFAULT' as const,
    enabled: true,
    identityKey: null,
  };
  const f = fixture([current]);
  const imported = { ...source, id: current.id, kind: 'NATIVE_DEFAULT' as const };
  const ids = await restoreCodexAccountMetadata(f.tx, [imported]);
  expect(ids.get(current.id)).not.toBe(current.id);
  expect(f.rows[0]).toEqual(current);
  expect(f.rows[1]).toMatchObject({ kind: 'MANAGED', identityKey: source.identityKey });
});
it('preserves a conflicting local row and gives imported sessions their own empty profile', async () => {
  const current = { ...source, identityKey: 'b'.repeat(64) };
  const f = fixture([current]);
  const ids = await restoreCodexAccountMetadata(f.tx, [source]);
  expect(ids.get(source.id)).not.toBe(source.id);
  expect(f.rows[0]).toEqual(current);
  expect(f.rows[1]).toMatchObject({ identityKey: source.identityKey, kind: 'MANAGED' });
});

it('keeps unverified native-email fallback imports separate without violating identity uniqueness', async () => {
  const original = {
    ...source,
    id: 'codex-native-default',
    kind: 'NATIVE_DEFAULT' as const,
    identityKey: `native-email:${'a'.repeat(64)}`,
  };
  const f = fixture([original]);
  const ids = await restoreCodexAccountMetadata(f.tx, [original]);
  expect(ids.get(original.id)).not.toBe(original.id);
  expect(f.rows[1]?.identityKey).not.toBe(original.identityKey);
  expect(f.rows[1]?.identityKey).toMatch(/^native-email:a{64}:imported:/);
});

it('restores a maximum-length native label into metadata that can be exported again', async () => {
  const f = fixture();
  await restoreCodexAccountMetadata(f.tx, [
    { ...source, id: 'codex-native-default', kind: 'NATIVE_DEFAULT', label: 'x'.repeat(100) },
  ]);
  expect(codexAccountMetadataSchema.safeParse(f.rows[0]).success).toBe(true);
});
