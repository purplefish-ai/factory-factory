import { type AgentSession, Prisma, type SessionProvider } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
import { userSettingsAccessor } from '@/backend/services/settings';
import { SessionStatus } from '@/shared/core';

export type AgentSessionRecord = AgentSession;

export type AgentSessionRecordWithWorkspace = Prisma.AgentSessionGetPayload<{
  include: { workspace: true };
}>;

const ACTIVE_AGENT_SESSION_STATUSES: SessionStatus[] = [SessionStatus.RUNNING, SessionStatus.IDLE];

export interface AgentSessionFilters {
  status?: SessionStatus;
  provider?: SessionProvider;
  limit?: number;
}

export interface CreateAgentSessionInput {
  workspaceId: string;
  name?: string;
  workflow: string;
  model?: string;
  provider?: SessionProvider;
  providerProjectPath?: string | null;
}

export interface UpdateAgentSessionInput {
  name?: string;
  workflow?: string;
  model?: string;
  status?: SessionStatus;
  provider?: SessionProvider;
  providerMetadata?: Prisma.InputJsonValue | null;
  providerSessionId?: string | null;
  providerProjectPath?: string | null;
  providerProcessPid?: number | null;
}

export interface AcquireFixerAgentSessionInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  maxSessions: number;
  provider?: SessionProvider;
  providerProjectPath: string | null;
}

export type FixerAgentSessionAcquisition =
  | { outcome: 'existing'; sessionId: string; status: SessionStatus }
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; sessionId: string };

export interface AgentSessionAccessor {
  create(data: CreateAgentSessionInput): Promise<AgentSessionRecord>;
  findById(id: string): Promise<AgentSessionRecordWithWorkspace | null>;
  findByIds(ids: string[]): Promise<AgentSessionRecord[]>;
  findByWorkspaceId(
    workspaceId: string,
    filters?: AgentSessionFilters
  ): Promise<AgentSessionRecord[]>;
  countActiveByWorkspaceId(workspaceId: string): Promise<number>;
  update(id: string, data: UpdateAgentSessionInput): Promise<AgentSessionRecord>;
  delete(id: string): Promise<AgentSessionRecord>;
  findWithPid(): Promise<AgentSessionRecord[]>;
  acquireFixerSession(input: AcquireFixerAgentSessionInput): Promise<FixerAgentSessionAcquisition>;
}

class PrismaAgentSessionAccessor implements AgentSessionAccessor {
  private async getConfiguredDefaultModel(provider: SessionProvider): Promise<string> {
    const settings = await userSettingsAccessor.get();
    return resolveSessionModelForProvider(
      undefined,
      provider,
      provider === 'CLAUDE' ? settings.defaultClaudeModel : settings.defaultCodexModel
    );
  }

  async create(data: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    const provider = data.provider ?? 'CLAUDE';
    const fallbackModel = await this.getConfiguredDefaultModel(provider);

    return await prisma.agentSession.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        workflow: data.workflow,
        model: resolveSessionModelForProvider(data.model, provider, fallbackModel),
        provider,
        providerProjectPath: data.providerProjectPath ?? null,
      },
    });
  }

  findById(id: string): Promise<AgentSessionRecordWithWorkspace | null> {
    return prisma.agentSession.findUnique({
      where: { id },
      include: { workspace: true },
    });
  }

  findByIds(ids: string[]): Promise<AgentSessionRecord[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return prisma.agentSession.findMany({
      where: {
        id: { in: ids },
      },
    });
  }

  findByWorkspaceId(
    workspaceId: string,
    filters?: AgentSessionFilters
  ): Promise<AgentSessionRecord[]> {
    const where: Prisma.AgentSessionWhereInput = { workspaceId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.provider) {
      where.provider = filters.provider;
    }

    return prisma.agentSession.findMany({
      where,
      take: filters?.limit,
      orderBy: { createdAt: 'asc' },
    });
  }

  countActiveByWorkspaceId(workspaceId: string): Promise<number> {
    return prisma.agentSession.count({
      where: {
        workspaceId,
        status: { in: ACTIVE_AGENT_SESSION_STATUSES },
      },
    });
  }

  update(id: string, data: UpdateAgentSessionInput): Promise<AgentSessionRecord> {
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
      providerSessionId: data.providerSessionId,
      providerProjectPath: data.providerProjectPath,
      providerProcessPid: data.providerProcessPid,
    };

    return prisma.agentSession.update({
      where: { id },
      data: updateData,
    });
  }

  delete(id: string): Promise<AgentSessionRecord> {
    return prisma.agentSession.delete({ where: { id } });
  }

  findWithPid(): Promise<AgentSessionRecord[]> {
    return prisma.agentSession.findMany({
      where: {
        providerProcessPid: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  acquireFixerSession(input: AcquireFixerAgentSessionInput): Promise<FixerAgentSessionAcquisition> {
    const provider = input.provider ?? 'CLAUDE';
    return this.getConfiguredDefaultModel(provider).then((fallbackModel) =>
      prisma.$transaction(async (tx) => {
        const existingSession = await tx.agentSession.findFirst({
          where: {
            workspaceId: input.workspaceId,
            workflow: input.workflow,
            provider,
            status: { in: ACTIVE_AGENT_SESSION_STATUSES },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingSession) {
          return {
            outcome: 'existing' as const,
            sessionId: existingSession.id,
            status: existingSession.status,
          };
        }

        const activeSessionCount = await tx.agentSession.count({
          where: {
            workspaceId: input.workspaceId,
            status: { in: ACTIVE_AGENT_SESSION_STATUSES },
          },
        });

        if (activeSessionCount >= input.maxSessions) {
          return { outcome: 'limit_reached' as const };
        }

        const recentSession = await tx.agentSession.findFirst({
          where: {
            workspaceId: input.workspaceId,
            workflow: { not: input.workflow },
            provider,
          },
          orderBy: { updatedAt: 'desc' },
          select: { model: true },
        });

        const model = resolveSessionModelForProvider(recentSession?.model, provider, fallbackModel);

        const newSession = await tx.agentSession.create({
          data: {
            workspaceId: input.workspaceId,
            workflow: input.workflow,
            name: input.sessionName,
            model,
            status: SessionStatus.IDLE,
            provider,
            providerProjectPath: input.providerProjectPath,
          },
        });

        return {
          outcome: 'created' as const,
          sessionId: newSession.id,
        };
      })
    );
  }
}

export const agentSessionAccessor: AgentSessionAccessor = new PrismaAgentSessionAccessor();
