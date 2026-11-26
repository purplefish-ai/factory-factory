import { prisma } from '@/backend/db';

/**
 * Reads and writes for recovering interrupted archives. An ARCHIVING row's
 * `updatedAt` is its archive's lease: the archive renews it while it runs, and
 * whoever takes the row over claims it with a compare-and-swap on that value.
 */
class WorkspaceArchiveRecoveryAccessor {
  /** Moves `updatedAt` from `expectedUpdatedAt` to `claimedAt`; false when anyone wrote the row since. */
  async claimArchiving(id: string, expectedUpdatedAt: Date, claimedAt: Date): Promise<boolean> {
    const result = await prisma.workspace.updateMany({
      where: { id, status: 'ARCHIVING', updatedAt: expectedUpdatedAt },
      data: { updatedAt: claimedAt },
    });
    return result.count > 0;
  }

  /** Renews the lease of an archive in progress; false once the row has left ARCHIVING. */
  async renewArchiving(id: string, renewedAt: Date): Promise<boolean> {
    const result = await prisma.workspace.updateMany({
      where: { id, status: 'ARCHIVING' },
      data: { updatedAt: renewedAt },
    });
    return result.count > 0;
  }

  /** The IDs among `ids` of ARCHIVED workspaces in the project. */
  async findArchivedIds(projectId: string, ids: string[]): Promise<Set<string>> {
    const rows = await prisma.workspace.findMany({
      where: { projectId, status: 'ARCHIVED', id: { in: ids } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }
}

export const workspaceArchiveRecoveryAccessor = new WorkspaceArchiveRecoveryAccessor();
