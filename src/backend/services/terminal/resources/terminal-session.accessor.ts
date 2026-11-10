import { prisma } from '@/backend/db';
import type { SessionStatus } from '@/shared/core';
import type { Prisma, TerminalSession } from '@prisma-gen/client';

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

/**
 * The joined workspace leaves out the startup log and `creationMetadata`
 * (base64 initial attachments), which terminal reads never use.
 */
const workspaceWithoutBlobs = {
  omit: { initOutput: true, creationMetadata: true },
} satisfies Prisma.WorkspaceDefaultArgs;

type TerminalSessionWithWorkspace = Prisma.TerminalSessionGetPayload<{
  include: { workspace: typeof workspaceWithoutBlobs };
}>;

class TerminalSessionAccessor {
  create(data: CreateTerminalSessionInput, assertCurrent?: () => void): Promise<TerminalSession> {
    if (assertCurrent) {
      return prisma.$transaction(async (tx) => {
        assertCurrent();
        const row = await tx.terminalSession.create({ data });
        assertCurrent();
        return row;
      });
    }
    return prisma.terminalSession.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        pid: data.pid,
      },
    });
  }

  async deleteIfPidMatches(id: string, pid: number): Promise<void> {
    await prisma.terminalSession.deleteMany({ where: { id, pid } });
  }

  findById(id: string): Promise<TerminalSessionWithWorkspace | null> {
    return prisma.terminalSession.findUnique({
      where: { id },
      include: { workspace: workspaceWithoutBlobs },
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

  async clearPid(workspaceId: string, name: string, expectedPid?: number): Promise<void> {
    await prisma.terminalSession.updateMany({
      where: { workspaceId, name, ...(expectedPid !== undefined && { pid: expectedPid }) },
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
