import type { Prisma, RatchetDispatchOutcome, WorkspacePRRatchet } from '@prisma-gen/client';
import { prisma } from '@/backend/db';

export type PRDispatchGuard = Pick<
  WorkspacePRRatchet,
  'activeSessionId' | 'dispatchSnapshotKey' | 'dispatchOutcome' | 'dispatchRetryCount'
>;
class WorkspacePRRatchetAccessor {
  async create(tx: Prisma.TransactionClient, prId: string): Promise<void> {
    await tx.workspacePRRatchet.create({ data: { prId } });
  }
  read(tx: Prisma.TransactionClient, prId: string) {
    return tx.workspacePRRatchet.findUnique({ where: { prId } });
  }
  async recordDispatch(
    tx: Prisma.TransactionClient,
    prId: string,
    input: { sessionId: string; snapshotKey: string; retryCount: number }
  ) {
    await tx.workspacePRRatchet.update({
      where: { prId },
      data: {
        activeSessionId: input.sessionId,
        dispatchSnapshotKey: input.snapshotKey,
        dispatchOutcome: 'RUNNING',
        dispatchRetryCount: input.retryCount,
        dispatchStalled: false,
      },
    });
  }
  async settle(
    tx: Prisma.TransactionClient,
    prId: string,
    sessionId: string,
    outcome: Exclude<RatchetDispatchOutcome, 'RUNNING'>
  ) {
    await tx.workspacePRRatchet.updateMany({
      where: { prId, activeSessionId: sessionId },
      data: { activeSessionId: null, dispatchOutcome: outcome },
    });
  }
  async reset(tx: Prisma.TransactionClient, prId: string, guard?: PRDispatchGuard) {
    const result = await tx.workspacePRRatchet.updateMany({
      where: {
        prId,
        ...(guard ?? { OR: [{ dispatchOutcome: null }, { dispatchOutcome: { not: 'RUNNING' } }] }),
      },
      data: {
        activeSessionId: null,
        ...(guard ? {} : { dispatchSnapshotKey: null }),
        dispatchOutcome: null,
        dispatchRetryCount: 0,
        dispatchStalled: false,
      },
    });
    return result.count > 0;
  }
  async resetForWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
    await tx.workspacePRRatchet.updateMany({
      where: { pr: { workspaceId } },
      data: {
        activeSessionId: null,
        dispatchSnapshotKey: null,
        dispatchOutcome: null,
        dispatchRetryCount: 0,
        dispatchStalled: false,
      },
    });
  }
  async markDispatchStalled(workspaceId: string, prId: string, snapshotKey: string) {
    const result = await prisma.workspacePRRatchet.updateMany({
      where: {
        prId,
        dispatchSnapshotKey: snapshotKey,
        dispatchStalled: false,
        pr: { workspaceId, detachedAt: null, workspace: { ratchet: { enabled: true } } },
      },
      data: { dispatchStalled: true },
    });
    return result.count > 0;
  }
  async recordCheck(tx: Prisma.TransactionClient, prId: string, checkedAt: Date) {
    await tx.workspacePRRatchet.update({ where: { prId }, data: { lastCheckedAt: checkedAt } });
  }
}
export const workspacePrRatchetAccessor = new WorkspacePRRatchetAccessor();
