import { expect, it, vi } from 'vitest';
import type { DataBackupTransactionClient } from '@/backend/services/settings';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { selectRecoveryGraph } from './data-backup-graph';

it('preloads existing workspace identities in bounded chunks before ordered graph traversal', async () => {
  const occupied = new Set(['workspace-1', 'workspace-202']);
  const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.filter((id) => occupied.has(id)).map((id) => ({ id }))
  );
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) =>
    occupied.has(where.id) ? { id: where.id } : null
  );
  const tx = unsafeCoerce<DataBackupTransactionClient>({ workspace: { findMany, findUnique } });
  const workspaces = Array.from({ length: 405 }, (_, index) => ({
    id: `workspace-${index}`,
    projectId: 'project',
    parentWorkspaceId: null,
  }));
  const data = unsafeCoerce<ExportData['data']>({
    projects: [],
    workspaces,
    agentSessions: [],
    terminalSessions: [],
    userSettings: null,
    codexAccounts: [],
  });
  const result = await selectRecoveryGraph(data, tx, new Set(['project']));
  expect(findMany.mock.calls.map(([args]) => args.where.id.in.length)).toEqual([200, 200, 5]);
  expect(findUnique).not.toHaveBeenCalled();
  expect(result.workspaces.map((row) => row.id)).toEqual(
    workspaces.filter((row) => !occupied.has(row.id)).map((row) => row.id)
  );
  for (const [args] of findMany.mock.calls) {
    expect(args).toEqual({ where: { id: { in: expect.any(Array) } }, select: { id: true } });
  }
});
