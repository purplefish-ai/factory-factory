import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => {
  const tx = {
    closedSession: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    agentSourceCheckpoint: { findMany: vi.fn(async () => []) },
    agentSourceHead: { findMany: vi.fn(async () => []) },
    chatIntent: { findMany: vi.fn(async () => []) },
    promptDispatchAttempt: { findMany: vi.fn(async () => []) },
    periodicTask: { findMany: vi.fn(async () => []) },
    periodicTaskExecution: { findMany: vi.fn(async () => []) },
    agentDefinition: { findMany: vi.fn(async () => []) },
    agentConnection: { findMany: vi.fn(async () => []) },
    agentTrigger: { findMany: vi.fn(async () => []) },
    agentRun: { findMany: vi.fn(async () => []) },
    agentProposal: { findMany: vi.fn(async () => []) },
    agentSourceState: { findMany: vi.fn(async () => []) },
    agentSourcePage: { findMany: vi.fn(async () => []) },
    agentSourceBaseline: { findMany: vi.fn(async () => []) },
    agentEvent: { findMany: vi.fn(async () => []) },
    agentEvaluation: { findMany: vi.fn(async () => []) },
    agentInitialDelivery: { findMany: vi.fn(async () => []) },
    workspaceNotification: { findMany: vi.fn(async () => []) },
    workspaceLaunchOrigin: { findMany: vi.fn(async () => []) },
    workspaceChildOrigin: { findMany: vi.fn(async () => []) },
    agentSessionLaunchOrigin: { findMany: vi.fn(async () => []) },
    sessionLifecycleEvent: { findMany: vi.fn(async () => []) },
    decisionLog: { findMany: vi.fn(async () => []) },
    project: { findMany: vi.fn(async () => []) },
    workspace: { findMany: vi.fn(async () => []) },
    agentSession: { findMany: vi.fn(async () => []) },
    terminalSession: { findMany: vi.fn(async () => []) },
    userSettings: { findFirst: vi.fn(async () => null) },
    codexAccount: {
      findMany: vi.fn(async () => [
        {
          id: 'managed-account',
          label: 'Managed account',
          kind: 'MANAGED',
          enabled: true,
          identityKey: null,
        },
      ]),
    },
  };
  return { tx, transaction: vi.fn(async (read) => read(tx)) };
});
vi.mock('@/backend/db', () => ({ prisma: { $transaction: state.transaction } }));
vi.mock('./backup-snapshot', () => ({
  withBackupSnapshot: (_source: unknown, read: Parameters<typeof state.transaction>[0]) =>
    state.transaction(read),
  withBackupImport: (_source: unknown, read: Parameters<typeof state.transaction>[0]) =>
    state.transaction(read),
}));
import { dataBackupAccessor } from './data-backup.accessor';
it('includes account identity metadata in the relational snapshot transaction', async () => {
  const snapshot = await dataBackupAccessor.getSnapshotForExport();
  expect(state.transaction).toHaveBeenCalledOnce();
  expect(state.tx.codexAccount.findMany).toHaveBeenCalledExactlyOnceWith({
    orderBy: { createdAt: 'asc' },
    select: { id: true, label: true, kind: true, enabled: true, identityKey: true },
  });
  expect(snapshot.codexAccounts).toEqual([
    {
      id: 'managed-account',
      label: 'Managed account',
      kind: 'MANAGED',
      enabled: true,
      identityKey: null,
    },
  ]);
});
