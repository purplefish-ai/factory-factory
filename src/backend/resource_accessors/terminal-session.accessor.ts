import type { SessionStatus } from '@factory-factory/core';
import type { Prisma, TerminalSession } from '@prisma-gen/client';
import { prisma } from '@/backend/db';

interface CreateTerminalSessionInput {
  workspaceId: string;
  name?: string;
  pid?: number;
}

interface UpdateTerminalSessionInput {
  name?: string;
  status?: SessionStatus;
  pid?: number | null;
}

interface FindByWorkspaceIdFilters {
  status?: SessionStatus;
  limit?: number;
}

// Type for TerminalSession with workspace included
type TerminalSessionWithWorkspace = Prisma.TerminalSessionGetPayload<{
  include: { workspace: true };
}>;

class TerminalSessionAccessor {
  create(data: CreateTerminalSessionInput): Promise<TerminalSession> {
    return prisma.terminalSession.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        pid: data.pid,
      },
    });
  }

  findById(id: string): Promise<TerminalSessionWithWorkspace | null> {
    return prisma.terminalSession.findUnique({
      where: { id },
      include: {
        workspace: true,
      },
    });
  }

  findByWorkspaceId(
    workspaceId: string,
    filters?: FindByWorkspaceIdFilters
  ): Promise<TerminalSession[]> {
    const where: Prisma.TerminalSessionWhereInput = { workspaceId };

    if (filters?.status) {
      where.status = filters.status;
    }

    return prisma.terminalSession.findMany({
      where,
      take: filters?.limit,
      orderBy: { updatedAt: 'desc' },
    });
  }

  findByName(name: string): Promise<TerminalSession | null> {
    return prisma.terminalSession.findFirst({
      where: { name },
    });
  }

  async clearPid(name: string): Promise<void> {
    await prisma.terminalSession.updateMany({
      where: { name },
      data: { pid: null },
    });
  }

  update(id: string, data: UpdateTerminalSessionInput): Promise<TerminalSession> {
    return prisma.terminalSession.update({
      where: { id },
      data,
    });
  }

  delete(id: string): Promise<TerminalSession> {
    return prisma.terminalSession.delete({
      where: { id },
    });
  }

  /**
   * Find all sessions where pid is not null.
   * Used for orphan process detection.
   */
  findWithPid(): Promise<TerminalSession[]> {
    return prisma.terminalSession.findMany({
      where: {
        pid: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
}

export const terminalSessionAccessor = new TerminalSessionAccessor();
