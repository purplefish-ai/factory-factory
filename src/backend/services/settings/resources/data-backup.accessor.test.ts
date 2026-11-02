import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => {
  const tx = {
    periodicTask: { findMany: vi.fn(async () => []) },
    periodicTaskExecution: { findMany: vi.fn(async () => []) },
    agentDefinition: { findMany: vi.fn(async () => []) },
    agentConnection: { findMany: vi.fn(async () => []) },
    agentTrigger: { findMany: vi.fn(async () => []) },
    project: { findMany: vi.fn(async () => []) },
    workspace: { findMany: vi.fn(async () => []) },
    agentSession: { findMany: vi.fn(async () => []) },
    terminalSession: { findMany: vi.fn(async () => []) },
    userSettings: { findFirst: vi.fn(async () => null) },
    codexAccount: { findMany: vi.fn(async () => []) },
  };
  return { tx, transaction: vi.fn(async (read) => read(tx)) };
});
vi.mock('@/backend/db', () => ({ prisma: { $transaction: state.transaction } }));
import { dataBackupAccessor } from './data-backup.accessor';
it('reads account identity and every relational row inside one consistent transaction', async () => {
  const snapshot = await dataBackupAccessor.getSnapshotForExport();
  expect(state.transaction).toHaveBeenCalledOnce();
  expect(state.tx.codexAccount.findMany).toHaveBeenCalledOnce();
  expect(snapshot.codexAccounts).toEqual([]);
});
