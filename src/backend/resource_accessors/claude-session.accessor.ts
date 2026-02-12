import { SessionStatus } from '@factory-factory/core';
import type { ClaudeSession, Prisma } from '@prisma-gen/client';
import { prisma } from '@/backend/db';

interface CreateClaudeSessionInput {
  workspaceId: string;
  name?: string;
  workflow: string;
  model?: string;
  claudeProjectPath?: string | null;
}

interface UpdateClaudeSessionInput {
  name?: string;
  workflow?: string;
  model?: string;
  status?: SessionStatus;
  claudeSessionId?: string | null;
  claudeProjectPath?: string | null;
  claudeProcessPid?: number | null;
}

interface FindByWorkspaceIdFilters {
  status?: SessionStatus;
  limit?: number;
}

interface AcquireFixerSessionInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  maxSessions: number;
  claudeProjectPath: string | null;
}

type FixerSessionAcquisition =
  | { outcome: 'existing'; sessionId: string; status: SessionStatus }
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; sessionId: string };

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
        claudeProjectPath: data.claudeProjectPath ?? null,
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
   * Acquire or create a workflow session for a fixer job in a single transaction.
   * Ensures limit checks and session creation are atomic.
   */
  acquireFixerSession(input: AcquireFixerSessionInput): Promise<FixerSessionAcquisition> {
    return prisma.$transaction(async (tx) => {
      const existingSession = await tx.claudeSession.findFirst({
        where: {
          workspaceId: input.workspaceId,
          workflow: input.workflow,
          status: { in: [SessionStatus.RUNNING, SessionStatus.IDLE] },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (existingSession) {
        return {
          outcome: 'existing',
          sessionId: existingSession.id,
          status: existingSession.status,
        };
      }

      const allSessions = await tx.claudeSession.findMany({
        where: { workspaceId: input.workspaceId },
        select: { id: true },
      });

      if (allSessions.length >= input.maxSessions) {
        return { outcome: 'limit_reached' };
      }

      const recentSession = await tx.claudeSession.findFirst({
        where: { workspaceId: input.workspaceId, workflow: { not: input.workflow } },
        orderBy: { updatedAt: 'desc' },
        select: { model: true },
      });

      const model = recentSession?.model ?? 'sonnet';

      const newSession = await tx.claudeSession.create({
        data: {
          workspaceId: input.workspaceId,
          workflow: input.workflow,
          name: input.sessionName,
          model,
          status: SessionStatus.IDLE,
          claudeProjectPath: input.claudeProjectPath,
        },
      });

      return {
        outcome: 'created',
        sessionId: newSession.id,
      };
    });
  }
}

export const claudeSessionAccessor = new ClaudeSessionAccessor();
