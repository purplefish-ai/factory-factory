import type { Prisma, WorkspacePRDiscovery } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import type { PRDiscoveryClaim } from '@/backend/services/workspace/types';

export function flattenPRDiscovery(row?: WorkspacePRDiscovery | null) {
  return {
    prDiscoveryLastCheckedAt: row?.lastCheckedAt ?? null,
    prDiscoveryRetryCount: row?.retryCount ?? 0,
    prDiscoveryNextCheckAt: row?.nextCheckAt ?? null,
  };
}

class WorkspacePRDiscoveryAccessor {
  async findNeedingDiscovery(limit: number, dueAt: Date) {
    const rows = await prisma.workspace.findMany({
      where: {
        status: 'READY',
        branchName: { not: null },
        project: { githubOwner: { not: null }, githubRepo: { not: null } },
        prDiscovery: { OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: dueAt } }] },
      },
      include: { project: true, prDiscovery: true },
      orderBy: [{ prDiscovery: { nextCheckAt: 'asc' } }, { updatedAt: 'desc' }],
      take: limit,
    });
    return rows.map(({ prDiscovery, ...row }) => ({ ...row, ...flattenPRDiscovery(prDiscovery) }));
  }

  async claimDiscoveryAttempt(
    workspaceId: string,
    attempt: {
      branchName: string;
      expectedUpdatedAt: Date;
      expectedRetryCount: number;
      expectedNextCheckAt: Date | null;
      checkedAt: Date;
      nextCheckAt: Date;
    }
  ): Promise<boolean> {
    const result = await prisma.workspacePRDiscovery.updateMany({
      where: {
        workspaceId,
        retryCount: attempt.expectedRetryCount,
        nextCheckAt: attempt.expectedNextCheckAt,
        workspace: {
          status: 'READY',
          branchName: attempt.branchName,
          updatedAt: attempt.expectedUpdatedAt,
        },
      },
      data: {
        lastCheckedAt: attempt.checkedAt,
        retryCount: { increment: 1 },
        nextCheckAt: attempt.nextCheckAt,
      },
    });
    return result.count > 0;
  }

  async claimMatches(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    claim: PRDiscoveryClaim
  ): Promise<boolean> {
    return (
      (await tx.workspacePRDiscovery.count({
        where: {
          workspaceId,
          lastCheckedAt: claim.checkedAt,
          retryCount: claim.retryCount,
          nextCheckAt: claim.nextCheckAt,
          workspace: { status: 'READY', branchName: claim.branchName },
        },
      })) > 0
    );
  }

  async resetDiscoveryBackoff(workspaceId: string): Promise<boolean> {
    const result = await prisma.workspacePRDiscovery.updateMany({
      where: { workspaceId, workspace: { status: 'READY', branchName: { not: null } } },
      data: { lastCheckedAt: null, retryCount: 0, nextCheckAt: null },
    });
    return result.count > 0;
  }

  async clearDiscoverySchedule(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
    await tx.workspacePRDiscovery.update({
      where: { workspaceId },
      data: { lastCheckedAt: null, retryCount: 0, nextCheckAt: null },
    });
  }
}
export const workspacePrDiscoveryAccessor = new WorkspacePRDiscoveryAccessor();
