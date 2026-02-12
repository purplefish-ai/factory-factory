import { SessionStatus } from '@factory-factory/core';
import { type AgentSession, Prisma, SessionProvider, type Workspace } from '@prisma-gen/client';
import { prisma } from '@/backend/db';

export type ClaudeSession = Omit<
  AgentSession,
  'providerSessionId' | 'providerProjectPath' | 'providerProcessPid'
> & {
  claudeSessionId: string | null;
  claudeProjectPath: string | null;
  claudeProcessPid: number | null;
};

export type ClaudeSessionWithWorkspace = ClaudeSession & {
  workspace: Workspace;
};

interface CreateClaudeSessionInput {
  workspaceId: string;
  name?: string;
  workflow: string;
  model?: string;
  provider?: SessionProvider;
  claudeProjectPath?: string | null;
}

interface UpdateClaudeSessionInput {
  name?: string;
  workflow?: string;
  model?: string;
  status?: SessionStatus;
  provider?: SessionProvider;
  providerMetadata?: Prisma.InputJsonValue | null;
  claudeSessionId?: string | null;
  claudeProjectPath?: string | null;
  claudeProcessPid?: number | null;
}

interface FindByWorkspaceIdFilters {
  status?: SessionStatus;
  provider?: SessionProvider;
  limit?: number;
}

interface AcquireFixerSessionInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  maxSessions: number;
  provider?: SessionProvider;
  claudeProjectPath: string | null;
}

type FixerSessionAcquisition =
  | { outcome: 'existing'; sessionId: string; status: SessionStatus }
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; sessionId: string };

type AgentSessionWithWorkspace = Prisma.AgentSessionGetPayload<{
  include: { workspace: true };
}>;

function toLegacySession(session: AgentSession): ClaudeSession {
  return {
    ...session,
    claudeSessionId: session.providerSessionId,
    claudeProjectPath: session.providerProjectPath,
    claudeProcessPid: session.providerProcessPid,
  };
}

function toLegacySessionWithWorkspace(
  session: AgentSessionWithWorkspace
): ClaudeSessionWithWorkspace {
  return {
    ...toLegacySession(session),
    workspace: session.workspace,
  };
}

class ClaudeSessionAccessor {
  create(data: CreateClaudeSessionInput): Promise<ClaudeSession> {
    return prisma.agentSession
      .create({
        data: {
          workspaceId: data.workspaceId,
          name: data.name,
          workflow: data.workflow,
          model: data.model ?? 'sonnet',
          provider: data.provider ?? SessionProvider.CLAUDE,
          providerProjectPath: data.claudeProjectPath ?? null,
        },
      })
      .then(toLegacySession);
  }

  findById(id: string): Promise<ClaudeSessionWithWorkspace | null> {
    return prisma.agentSession
      .findUnique({
        where: { id },
        include: {
          workspace: true,
        },
      })
      .then((session) => (session ? toLegacySessionWithWorkspace(session) : null));
  }

  findByWorkspaceId(
    workspaceId: string,
    filters?: FindByWorkspaceIdFilters
  ): Promise<ClaudeSession[]> {
    const where: Prisma.AgentSessionWhereInput = { workspaceId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.provider) {
      where.provider = filters.provider;
    }

    return prisma.agentSession
      .findMany({
        where,
        take: filters?.limit,
        orderBy: { createdAt: 'asc' },
      })
      .then((sessions) => sessions.map(toLegacySession));
  }

  update(id: string, data: UpdateClaudeSessionInput): Promise<ClaudeSession> {
    const updateData: Prisma.AgentSessionUpdateInput = {
      name: data.name,
      workflow: data.workflow,
      model: data.model,
      status: data.status,
      provider: data.provider,
      providerMetadata:
        data.providerMetadata === undefined
          ? undefined
          : data.providerMetadata === null
            ? Prisma.JsonNull
            : data.providerMetadata,
      providerSessionId: data.claudeSessionId,
      providerProjectPath: data.claudeProjectPath,
      providerProcessPid: data.claudeProcessPid,
    };

    return prisma.agentSession
      .update({
        where: { id },
        data: updateData,
      })
      .then(toLegacySession);
  }

  delete(id: string): Promise<ClaudeSession> {
    return prisma.agentSession
      .delete({
        where: { id },
      })
      .then(toLegacySession);
  }

  /**
   * Find all sessions where providerProcessPid is not null.
   * Used for orphan process detection.
   */
  findWithPid(): Promise<ClaudeSession[]> {
    return prisma.agentSession
      .findMany({
        where: {
          providerProcessPid: { not: null },
        },
        orderBy: { updatedAt: 'desc' },
      })
      .then((sessions) => sessions.map(toLegacySession));
  }

  /**
   * Acquire or create a workflow session for a fixer job in a single transaction.
   * Ensures limit checks and session creation are atomic.
   */
  acquireFixerSession(input: AcquireFixerSessionInput): Promise<FixerSessionAcquisition> {
    return prisma.$transaction(async (tx) => {
      const existingSession = await tx.agentSession.findFirst({
        where: {
          workspaceId: input.workspaceId,
          workflow: input.workflow,
          provider: input.provider ?? SessionProvider.CLAUDE,
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

      const allSessions = await tx.agentSession.findMany({
        where: { workspaceId: input.workspaceId },
        select: { id: true },
      });

      if (allSessions.length >= input.maxSessions) {
        return { outcome: 'limit_reached' };
      }

      const recentSession = await tx.agentSession.findFirst({
        where: {
          workspaceId: input.workspaceId,
          workflow: { not: input.workflow },
          provider: input.provider ?? SessionProvider.CLAUDE,
        },
        orderBy: { updatedAt: 'desc' },
        select: { model: true },
      });

      const model = recentSession?.model ?? 'sonnet';

      const newSession = await tx.agentSession.create({
        data: {
          workspaceId: input.workspaceId,
          workflow: input.workflow,
          name: input.sessionName,
          model,
          status: SessionStatus.IDLE,
          provider: input.provider ?? SessionProvider.CLAUDE,
          providerProjectPath: input.claudeProjectPath,
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
