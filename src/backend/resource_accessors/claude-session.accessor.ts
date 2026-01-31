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

  // ===========================================================================
  // Pending Messages Queue Management
  // ===========================================================================

  /**
   * Get pending messages for a session.
   */
  async getPendingMessages(id: string): Promise<PendingMessageData[]> {
    const session = await prisma.claudeSession.findUnique({
      where: { id },
      select: { pendingMessages: true },
    });
    if (!session?.pendingMessages) {
      return [];
    }
    try {
      return JSON.parse(session.pendingMessages) as PendingMessageData[];
    } catch {
      return [];
    }
  }

  /**
   * Add a message to the pending queue.
   */
  async addPendingMessage(id: string, message: PendingMessageData): Promise<void> {
    const existing = await this.getPendingMessages(id);
    existing.push(message);
    await prisma.claudeSession.update({
      where: { id },
      data: { pendingMessages: JSON.stringify(existing) },
    });
  }

  /**
   * Clear all pending messages for a session.
   */
  async clearPendingMessages(id: string): Promise<void> {
    await prisma.claudeSession.update({
      where: { id },
      data: { pendingMessages: null },
    });
  }

  /**
   * Get and clear all pending messages (atomic pop).
   */
  async popPendingMessages(id: string): Promise<PendingMessageData[]> {
    const messages = await this.getPendingMessages(id);
    if (messages.length > 0) {
      await this.clearPendingMessages(id);
    }
    return messages;
  }
}

/**
 * Shape of a pending message stored in the database.
 */
export interface PendingMessageData {
  id: string;
  text: string;
  timestamp: string;
  /** For image attachments - stored as array of content items */
  content?: unknown[];
}

export const claudeSessionAccessor = new ClaudeSessionAccessor();
