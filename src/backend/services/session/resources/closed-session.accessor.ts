import type { ClosedSession, Prisma, SessionProvider } from '@prisma-gen/client';
import { prisma } from '@/backend/db';

export type ClosedSessionRecord = ClosedSession;

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
  findByWorkspaceId(workspaceId: string, limit: number): Promise<ClosedSessionRecord[]> {
    return prisma.closedSession.findMany({
      where: { workspaceId },
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
      },
    });
  }

  findByIdWithWorkspace(id: string): Promise<ClosedSessionWithWorkspace | null> {
    return prisma.closedSession.findUnique({
      where: { id },
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

  create(data: CreateClosedSessionInput): Promise<ClosedSessionRecord> {
    return prisma.closedSession.create({ data });
  }

  delete(id: string): Promise<ClosedSessionRecord> {
    return prisma.closedSession.delete({ where: { id } });
  }
}

export const closedSessionAccessor = new PrismaClosedSessionAccessor();
