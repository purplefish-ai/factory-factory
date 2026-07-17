import { type AgentSession, Prisma, type SessionProvider } from '@prisma-gen/client';
import { prisma } from '@/backend/db';
import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
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
  model: string;
  provider: SessionProvider;
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

const toAgentSessionUpdateData = (
  data: UpdateAgentSessionInput
): Prisma.AgentSessionUpdateManyMutationInput => ({
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
});

export interface AcquireFixerAgentSessionInput {
  workspaceId: string;
  workflow: string;
  sessionName: string;
  maxSessions: number;
  provider: SessionProvider;
  model: string;
  providerProjectPath: string | null;
}

export type FixerAgentSessionAcquisition =
  | { outcome: 'existing'; sessionId: string; status: SessionStatus }
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; sessionId: string };

export interface CreateLimitedAgentSessionInput extends CreateAgentSessionInput {
  maxSessions: number;
}

export type LimitedAgentSessionCreation =
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; session: AgentSessionRecord };

export interface AgentSessionAccessor {
  create(data: CreateAgentSessionInput): Promise<AgentSessionRecord>;
  createWithinWorkspaceLimit(
    data: CreateLimitedAgentSessionInput
  ): Promise<LimitedAgentSessionCreation>;
  findById(id: string): Promise<AgentSessionRecordWithWorkspace | null>;
  findByIds(ids: string[]): Promise<AgentSessionRecord[]>;
  findByWorkspaceId(
    workspaceId: string,
    filters?: AgentSessionFilters
  ): Promise<AgentSessionRecord[]>;
  countActiveByWorkspaceId(workspaceId: string): Promise<number>;
  update(id: string, data: UpdateAgentSessionInput): Promise<AgentSessionRecord>;
  updateIfStatus(
    id: string,
    data: UpdateAgentSessionInput,
    allowedStatuses: SessionStatus[]
  ): Promise<number>;
  delete(id: string): Promise<AgentSessionRecord>;
  findWithPid(): Promise<AgentSessionRecord[]>;
  recoverStaleRunning(): Promise<number>;
  acquireFixerSession(input: AcquireFixerAgentSessionInput): Promise<FixerAgentSessionAcquisition>;
}

class PrismaAgentSessionAccessor implements AgentSessionAccessor {
  /** Serialises per-workspace acquisition to prevent count-then-create races. */
  private readonly workspaceAcquisitionQueue = new Map<string, Promise<unknown>>();

  async create(data: CreateAgentSessionInput): Promise<AgentSessionRecord> {
    return await prisma.agentSession.create({
      data: {
        workspaceId: data.workspaceId,
        name: data.name,
        workflow: data.workflow,
        model: data.model,
        provider: data.provider,
        providerProjectPath: data.providerProjectPath ?? null,
      },
    });
  }

  createWithinWorkspaceLimit(
    data: CreateLimitedAgentSessionInput
  ): Promise<LimitedAgentSessionCreation> {
    return this.enqueueWorkspaceAcquisition(data.workspaceId, () =>
      this.doCreateWithinWorkspaceLimit(data)
    );
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
    return prisma.agentSession.update({
      where: { id },
      data: toAgentSessionUpdateData(data),
    });
  }

  async updateIfStatus(
    id: string,
    data: UpdateAgentSessionInput,
    allowedStatuses: SessionStatus[]
  ): Promise<number> {
    if (allowedStatuses.length === 0) {
      return 0;
    }

    const result = await prisma.agentSession.updateMany({
      where: {
        id,
        status: { in: allowedStatuses },
      },
      data: toAgentSessionUpdateData(data),
    });

    return result.count;
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

  async recoverStaleRunning(): Promise<number> {
    const result = await prisma.agentSession.updateMany({
      where: {
        status: SessionStatus.RUNNING,
      },
      data: {
        status: SessionStatus.IDLE,
        providerProcessPid: null,
      },
    });

    return result.count;
  }

  acquireFixerSession(input: AcquireFixerAgentSessionInput): Promise<FixerAgentSessionAcquisition> {
    return this.enqueueWorkspaceAcquisition(input.workspaceId, () =>
      this.doAcquireFixerSession(input)
    );
  }

  private async enqueueWorkspaceAcquisition<T>(
    workspaceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const prev = this.workspaceAcquisitionQueue.get(workspaceId) ?? Promise.resolve();
    const current = prev
      .catch(() => {
        /* swallow so previous failure doesn't block queue */
      })
      .then(operation);
    this.workspaceAcquisitionQueue.set(workspaceId, current);
    try {
      return await current;
    } finally {
      if (this.workspaceAcquisitionQueue.get(workspaceId) === current) {
        this.workspaceAcquisitionQueue.delete(workspaceId);
      }
    }
  }

  private async doCreateWithinWorkspaceLimit(
    data: CreateLimitedAgentSessionInput
  ): Promise<LimitedAgentSessionCreation> {
    const activeSessionCount = await prisma.agentSession.count({
      where: {
        workspaceId: data.workspaceId,
        status: { in: ACTIVE_AGENT_SESSION_STATUSES },
      },
    });

    if (activeSessionCount >= data.maxSessions) {
      return { outcome: 'limit_reached' };
    }

    const session = await this.create(data);
    return { outcome: 'created', session };
  }

  private async doAcquireFixerSession(
    input: AcquireFixerAgentSessionInput
  ): Promise<FixerAgentSessionAcquisition> {
    const existingSession = await prisma.agentSession.findFirst({
      where: {
        workspaceId: input.workspaceId,
        workflow: input.workflow,
        provider: input.provider,
        status: { in: ACTIVE_AGENT_SESSION_STATUSES },
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

    const activeSessionCount = await prisma.agentSession.count({
      where: {
        workspaceId: input.workspaceId,
        status: { in: ACTIVE_AGENT_SESSION_STATUSES },
      },
    });

    if (activeSessionCount >= input.maxSessions) {
      return { outcome: 'limit_reached' };
    }

    const recentSession = await prisma.agentSession.findFirst({
      where: {
        workspaceId: input.workspaceId,
        workflow: { not: input.workflow },
        provider: input.provider,
      },
      orderBy: { updatedAt: 'desc' },
      select: { model: true },
    });

    const model = resolveSessionModelForProvider(recentSession?.model, input.provider, input.model);

    const newSession = await prisma.agentSession.create({
      data: {
        workspaceId: input.workspaceId,
        workflow: input.workflow,
        name: input.sessionName,
        model,
        status: SessionStatus.IDLE,
        provider: input.provider,
        providerProjectPath: input.providerProjectPath,
      },
    });

    return {
      outcome: 'created',
      sessionId: newSession.id,
    };
  }
}

export const agentSessionAccessor: AgentSessionAccessor = new PrismaAgentSessionAccessor();
