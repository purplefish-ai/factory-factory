import type { ClaudeSession, Prisma, SessionStatus } from '@prisma-gen/client';
import { prisma } from '../db';

interface CreateClaudeSessionInput {
  workspaceId: string;
  name?: string;
  workflow: string;
  model?: string;
}

interface UpdateClaudeSessionInput {
  name?: string;
  workflow?: string;
  model?: string;
  status?: SessionStatus;
  claudeSessionId?: string | null;
  claudeProcessPid?: number | null;
}

interface FindByWorkspaceIdFilters {
  status?: SessionStatus;
  limit?: number;
}

// Type for ClaudeSession with workspace included
type ClaudeSessionWithWorkspace = Prisma.ClaudeSessionGetPayload<{
  include: { workspace: true };
}>;

class ClaudeSessionAccessor {
  create(data: CreateClaudeSessionInput): Promise<ClaudeSession> {
    return prisma.claudeSession.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        workflow: data.workflow,
        model: data.model ?? 'sonnet',
      },
    });
  }

  findById(id: string): Promise<ClaudeSessionWithWorkspace | null> {
    return prisma.claudeSession.findUnique({
      where: { id },
      include: {
        workspace: true,
      },
    });
  }

  findByWorkspaceId(
    workspaceId: string,
    filters?: FindByWorkspaceIdFilters
  ): Promise<ClaudeSession[]> {
    const where: Prisma.ClaudeSessionWhereInput = { workspaceId };

    if (filters?.status) {
      where.status = filters.status;
    }

    return prisma.claudeSession.findMany({
      where,
      take: filters?.limit,
      orderBy: { createdAt: 'asc' },
    });
  }

  update(id: string, data: UpdateClaudeSessionInput): Promise<ClaudeSession> {
    return prisma.claudeSession.update({
      where: { id },
      data,
    });
  }

  delete(id: string): Promise<ClaudeSession> {
    return prisma.claudeSession.delete({
      where: { id },
    });
  }

  /**
   * Find all sessions where claudeProcessPid is not null.
   * Used for orphan process detection.
   */
  findWithPid(): Promise<ClaudeSession[]> {
    return prisma.claudeSession.findMany({
      where: {
        claudeProcessPid: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Find sessions for multiple workspaces in a single query.
   */
  findByWorkspaceIds(workspaceIds: string[]): Promise<ClaudeSession[]> {
    return prisma.claudeSession.findMany({
      where: {
        workspaceId: { in: workspaceIds },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}

export const claudeSessionAccessor = new ClaudeSessionAccessor();
