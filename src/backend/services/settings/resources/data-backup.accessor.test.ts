import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
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
