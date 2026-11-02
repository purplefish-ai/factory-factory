import { prisma } from '@/backend/db';
import type { ClosedSession, Prisma, SessionProvider } from '@prisma-gen/client';

export type ClosedSessionRecord = Omit<ClosedSession, 'pendingTranscript'>;

export type ClosedSessionWithWorkspace = Prisma.ClosedSessionGetPayload<{
  include: { workspace: { select: { id: true; worktreePath: true } } };
}>;

export interface CreateClosedSessionInput {
  workspaceId: string;
  sessionId: string;
  name: string | null;
  workflow: string;
  provider: SessionProvider;
  model: string;
  transcriptPath: string;
  startedAt: Date;
  completedAt: Date;
}

class PrismaClosedSessionAccessor {
  findBySessionIdWithWorkspace(sessionId: string): Promise<ClosedSessionWithWorkspace[]> {
    return prisma.closedSession.findMany({
      where: { sessionId, archiveState: 'COMPLETE' },
      orderBy: { completedAt: 'desc' },
      include: { workspace: { select: { id: true, worktreePath: true } } },
    });
  }
  findByWorkspaceId(workspaceId: string, limit: number): Promise<ClosedSessionRecord[]> {
    return prisma.closedSession.findMany({
      where: { workspaceId, archiveState: 'COMPLETE' },
      orderBy: { completedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        sessionId: true,
        workspaceId: true,
        name: true,
        workflow: true,
        provider: true,
        model: true,
        transcriptPath: true,
        startedAt: true,
        completedAt: true,
        archiveKey: true,
        archiveState: true,
        transcriptHash: true,
      },
    });
  }

  findByIdWithWorkspace(id: string): Promise<ClosedSessionWithWorkspace | null> {
    return prisma.closedSession.findUnique({
      where: { id, archiveState: 'COMPLETE' },
      include: {
        workspace: {
          select: {
            id: true,
            worktreePath: true,
          },
        },
      },
    });
  }

  findLegacy(workspaceId: string, limit = 50) {
    return prisma.closedSession.findMany({
      where: { workspaceId, archiveKey: null, archiveState: 'COMPLETE' },
      take: limit,
      orderBy: { id: 'asc' },
      include: { workspace: { select: { worktreePath: true } } },
    });
  }

  stageLegacy(
    id: string,
    data: {
      archiveKey: string;
      transcriptPath: string;
      pendingTranscript: string;
      transcriptHash: string;
    }
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.closedSession.updateMany({
        where: { id, archiveKey: null },
        data: { ...data, archiveState: 'PENDING' },
      });
      return tx.closedSession.findUniqueOrThrow({ where: { id } });
    });
  }

  reserve(
    data: CreateClosedSessionInput & {
      id: string;
      archiveKey: string;
      pendingTranscript: string;
      transcriptHash: string;
    }
  ): Promise<ClosedSession> {
    return prisma.$transaction((tx) =>
      tx.closedSession.upsert({
        where: { archiveKey: data.archiveKey },
        create: { ...data, archiveState: 'PENDING' },
        update: {},
      })
    );
  }

  findPending(workspaceId: string, limit = 50) {
    return prisma.closedSession.findMany({
      where: { workspaceId, archiveState: 'PENDING' },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }

  findPendingForSession(sessionId: string, limit = 50) {
    return prisma.closedSession.findMany({
      where: { sessionId, archiveState: 'PENDING' },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }

  cleanupDeletedWorkspace(workspaceId: string, remove: () => void) {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "ClosedSession" SET "id" = "id" WHERE 0`;
        if (
          !(await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }))
        ) {
          remove();
        }
      },
      { timeout: 30_000 }
    );
  }

  removeOrphan(id: string, transcriptHash: string, transcriptPath: string, remove: () => void) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "ClosedSession" SET "id" = "id" WHERE 0`;
      const owned = await tx.closedSession.findUnique({
        where: { id, transcriptHash, transcriptPath },
        select: { id: true },
      });
      // Never await filesystem work on the adapter's shared connection. All
      // archive mutations use transactions; the synchronous unlink cannot race
      // a reservation or import between this ownership check and removal.
      if (!owned) {
        remove();
      }
    });
  }

  complete(id: string, transcriptHash: string) {
    return prisma.$transaction((tx) =>
      tx.closedSession.update({
        where: { id, transcriptHash },
        data: { archiveState: 'COMPLETE', pendingTranscript: null },
      })
    );
  }

  completeWithRetainedTranscript(id: string, transcriptHash: string) {
    return prisma.$transaction((tx) =>
      tx.closedSession.update({
        where: { id, transcriptHash, pendingTranscript: { not: null } },
        data: { archiveState: 'COMPLETE' },
      })
    );
  }

  findRetainedTranscriptById(id: string) {
    return prisma.closedSession.findFirst({
      where: {
        id,
        archiveState: 'COMPLETE',
        archiveKey: { not: null },
        pendingTranscript: { not: null },
      },
    });
  }

  findArtifactOwner(id: string, transcriptHash: string, transcriptPath: string) {
    return prisma.closedSession.findUnique({
      where: { id, transcriptHash, transcriptPath },
      select: { id: true },
    });
  }

  findMaintenancePending(afterId?: string): Promise<ClosedSession[]> {
    return prisma.closedSession.findMany({
      where: { archiveState: 'PENDING', ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take: 50,
    });
  }

  findPendingById(id: string) {
    return prisma.closedSession.findFirst({ where: { id, archiveState: 'PENDING' } });
  }

  delete(id: string): Promise<ClosedSessionRecord> {
    return prisma.$transaction((tx) => tx.closedSession.delete({ where: { id } }));
  }
}

export const closedSessionAccessor = new PrismaClosedSessionAccessor();
